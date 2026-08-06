/**
 * Agent 模块的共享类型定义。
 * 统一管理会话、消息、工具调用、流式请求等类型，
 * 供 api.ts / hooks / tools 各子模块引用，避免循环依赖。
 */

// ── 流式对话请求参数 ──

export interface StreamAgentOptions {
  sessionId: string;
  modelId: string;
  content: string;
  refImages?: string[];
  skillName?: string;
  signal?: AbortSignal;
}

// ── 工具结果回传参数 ──

export interface ToolResultOptions {
  sessionId: string;
  modelId: string;
  toolCallId: string;
  result: string;
  signal?: AbortSignal;
}

// ── 消息与对话展示 ──

export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface ToolCallView {
  id: string;
  name: string;
  args: string;
  /** 后台下发的中文展示名（如 生成图片）；缺失时回退到 name */
  label?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** assistant 携带的工具调用（用于展示「调用工具」） */
  toolCalls?: ToolCallView[];
  /** role=tool 时对应的 tool_call_id */
  toolCallId?: string;
  /** user 消息携带的技能名（展示该消息由哪个技能驱动） */
  skill?: string;
  /** 标记该消息为错误（如上游返回错误），用于红色样式展示 */
  error?: boolean;
}

// ── 工具调用与执行 ──

/** 后端 tool_call 结构（与 /api/agent SSE 的 tool_call 事件一致） */
export interface AgentToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

/** 执行单个工具后回填给 LLM 的结果（带 role:"tool"） */
export interface AgentToolResult {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/** 位置计算函数签名（由调用方注入） */
export type FindFreePosition = (size: { width: number; height: number }) => { x: number; y: number };

/** 添加节点函数签名（由调用方注入） */
export type AddNodes = (nodes: import("@/features/canvas/types").AnyNode[]) => void;

/** 工具 spawner 签名（根据参数生成画布节点） */
export type AgentSpawner = (
  args: Record<string, unknown>,
  findFreePosition: FindFreePosition,
) => import("@/features/canvas/types").AnyNode;

// ── 会话列表项 ──

export interface SessionListItem {
  id: string;
  title: string;
  updatedAt: string;
  activeSkill?: string | null;
  skillStatus?: string;
}
