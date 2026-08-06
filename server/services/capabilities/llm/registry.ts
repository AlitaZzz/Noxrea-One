/**
 * Agent 工具中央注册器。
 * 统一注册供 LLM function-calling 使用的工具，新增工具只需调用 register()。
 * 工具执行位置分 client（后端透传、前端建节点）与 server（预留后端执行）两类。
 */

/** JSON Schema 基础类型（受控字面量，避免手写拼错 type） */
export type AgentToolParamType = "string" | "number" | "boolean" | "array" | "object";

export interface AgentToolParam {
  type: AgentToolParamType;
  description: string;
  /** 数组元素类型（type 为 "array" 时可选） */
  items?: AgentToolParamType;
  /** 数值下界（type 为 "number" 时可选） */
  minimum?: number;
  /** 数值上界（type 为 "number" 时可选） */
  maximum?: number;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, AgentToolParam>;
  required: string[];
  /** 执行位置标记，见上 */
  execute: "client" | "server";
  /** 对话气泡中展示的中文名（如 generate_image → 生成图片），由后台统一定义 */
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

  /** 所有已注册工具名 */
  names(): string[] {
    return [...this.defs.keys()];
  }

  /** 传给上游 LLM 的 tools 数组（OpenAI function-calling 格式） */
  getOpenAiTools(): unknown[] {
    return [...this.defs.values()].map((d) => ({
      type: "function",
      function: {
        name: d.name,
        description: d.description,
        parameters: {
          type: "object",
          properties: d.parameters,
          required: d.required,
        },
      },
    }));
  }
}

export const agentToolRegistry = new ToolRegistry();
