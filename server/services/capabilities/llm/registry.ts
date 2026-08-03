// ── Agent 工具中央注册器 ──
//
// 所有供 LLM function-calling 使用的工具都在此统一注册，避免散落在硬编码数组中。
// 新增一个工具只需调用 register()，无需修改任何分发逻辑。
//
// 工具的「执行位置」分为两类：
// - "client"：后端只透传 tool_call 给前端，由前端在画布上建节点（现有行为，默认）
// - "server"：预留扩展位，未来可由后端直接执行

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string }>;
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
