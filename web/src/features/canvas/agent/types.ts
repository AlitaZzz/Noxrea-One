/**
 * 画布 Agent 模块的共享类型定义。
 * 统一管理会话、消息、工具调用、流式请求等类型，
 * 供 api.ts / hooks / tools 各子模块引用，避免循环依赖。
 */

// ── 流式对话请求参数 ──

export interface StreamAgentOptions {
  sessionId: string;
  modelId: string;
  /** 供应商 id（providerId/modelName 稳定键的前半），缺省时由后端按模型名解析 */
  providerId?: string;
  content: string;
  refImages?: string[];
  /** 序列化的画布状态快照（仅随用户消息发送） */
  canvasState?: unknown;
  signal?: AbortSignal;
}

// ── 工具结果回传参数 ──

export interface ToolResultOptions {
  sessionId: string;
  modelId: string;
  providerId?: string;
  /** 本轮执行的全部工具结果 */
  results: Array<{ toolCallId: string; result: string }>;
  signal?: AbortSignal;
}

// ── 消息与对话展示 ──

export type ChatRole = "user" | "assistant" | "tool";

export interface ToolCallView {
  id: string;
  name: string;
  args: string;
  /** 后台下发的中文展示名（如 创建节点）；缺失时回退到 name */
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
  /** 标记该消息为错误（如上游返回错误），用于红色样式展示 */
  error?: boolean;
}

// ── 工具调用与执行 ──

/** 后端 tool_call 结构（与 /api/agent SSE 的 tool_call 事件一致） */
export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 执行单个工具后的结果 */
export interface AgentToolResult {
  toolCallId: string;
  content: string;
  /** 本轮是否有画布变更（决定是否补一次历史快照） */
  mutated: boolean;
}

// ── 会话列表项 ──

export interface SessionListItem {
  id: string;
  title: string;
  updatedAt: string;
}
