/**
 * Agent 工具中央注册器。
 * 统一注册供 LLM function-calling 使用的工具，新增工具只需调用 register()。
 * 工具执行位置分 client（后端透传、前端执行）与 server（后端执行）两类。
 *
 * 参数 schema 单一来源：注册时只写 zod schema，LLM function-calling 的
 * JSON Schema（getOpenAiTools）与运行时校验（validateArgs）都由它派生。
 *
 * 本文件属于 agent 模块，与 capabilities/llm（前端 text 节点纯文本能力）完全解耦。
 */
import { z } from "zod/v4";

export interface AgentToolDefinition {
  name: string;
  description: string;
  /** 参数 zod schema：字段用 .describe() 写给 LLM 看的参数说明 */
  zodSchema: z.ZodType;
  /** 执行位置标记：client 由前端执行，server 由后端处理 */
  execute: "client" | "server";
  /** 对话气泡中展示的中文名（如 create_node → 创建节点），由后台统一定义 */
  label: string;
}

class ToolRegistry {
  private defs = new Map<string, AgentToolDefinition>();

  /** 注册一个工具，重复注册同名会抛错（便于尽早发现冲突） */
  register(def: AgentToolDefinition): void {
    if (this.defs.has(def.name)) {
      throw new Error(`[tool] 重复注册: ${def.name}`);
    }
    this.defs.set(def.name, def);
  }

  /** 按名字取工具定义 */
  get(name: string): AgentToolDefinition | undefined {
    return this.defs.get(name);
  }

  /** 校验 LLM 返回的工具参数，返回校验后的数据或错误信息 */
  validateArgs(name: string, args: Record<string, unknown>): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
    const def = this.defs.get(name);
    if (!def) return { ok: false, error: `unknown tool: ${name}` };
    const result = def.zodSchema.safeParse(args);
    if (!result.success) return { ok: false, error: result.error.issues.map((i) => i.message).join("; ") };
    return { ok: true, data: result.data as Record<string, unknown> };
  }

  /** 所有已注册工具名 */
  names(): string[] {
    return [...this.defs.keys()];
  }

  /** 传给上游 LLM 的 tools 数组（OpenAI function-calling 格式） */
  getOpenAiTools(): unknown[] {
    return [...this.defs.values()].map((d) => {
      // 剥掉 $schema 头：部分 OpenAI 兼容上游对 schema 严格校验，保持与原手写 parameters 一致的精简形态
      const jsonSchema = z.toJSONSchema(d.zodSchema, { target: "draft-7" });
      const parameters = { ...jsonSchema } as Record<string, unknown>;
      delete parameters.$schema;
      return {
        type: "function",
        function: {
          name: d.name,
          description: d.description,
          parameters,
        },
      };
    });
  }
}

export const agentToolRegistry = new ToolRegistry();
