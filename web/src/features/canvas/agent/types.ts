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
  /** 序列化的画布状态快照（随用户消息与工具续轮发送，始终为最新状态） */
  canvasState?: unknown;
  /** 自上一条消息以来用户在画布上的操作 diff（drain 自 user-action-tracker） */
  userActions?: unknown;
  signal?: AbortSignal;
}

// ── 工具结果回传参数 ──

export interface ToolResultOptions {
  sessionId: string;
  modelId: string;
  providerId?: string;
  /** 本轮执行的全部工具结果 */
  results: Array<{ toolCallId: string; result: string }>;
  /** 序列化的画布状态快照（续轮重发，模型始终看到执行后的最新状态） */
  canvasState?: unknown;
  /** 工具续轮等待期间用户对画布的增量操作（对齐 tldraw：多轮期间改动可见） */
  userActions?: unknown;
  signal?: AbortSignal;
}

// ── 消息与对话展示 ──

export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface ToolCallView {
  id: string;
  name: string;
  args: string;
  /** 后台下发的中文展示名（如 创建节点）；缺失时回退到 name */
  label?: string;
}

/** 确认卡决策落定后的静默结果条（不落库，刷新后消失） */
export interface ConfirmResultInfo {
  approved: boolean;
  executedCount: number;
  skippedCount: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** assistant 携带的工具调用（用于展示「调用工具」） */
  toolCalls?: ToolCallView[];
  /** role=tool 时对应的 tool_call_id */
  toolCallId?: string;
  /** role=tool 时该次执行是否失败（操作行红叉依据） */
  failed?: boolean;
  /** role=tool 时该次调用因用户未勾选/拒绝而未执行（操作行灰叉「未执行」依据） */
  skipped?: boolean;
  /** 本回合生成的消息归属回合 id（回合分组与撤销按钮用；历史加载的旧消息无此字段） */
  turnId?: string;
  /** role=system 时：确认卡决策结果条 */
  confirmResult?: ConfirmResultInfo;
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

/** 用户对确认卡的决定（提议-确认流程） */
export interface ConfirmDecision {
  approved: boolean;
  /**
   * callId → 用户勾选保留的子集；缺省/undefined = 全选原样执行。
   * delete_edges 用 edgeIndexes（原 edges 数组下标）而非内容匹配，避免重复对歧义。
   */
  selections?: Record<string, { nodeIds?: string[]; edgeIndexes?: number[] }>;
}

/** 待用户确认的工具调用（提议-确认流程：删除类操作先确认再执行） */
export interface PendingConfirmation {
  id: string;
  calls: ToolCallView[];
  /** 目标节点 id（画布幻影蒙层与视口聚焦用，打开确认卡时算好） */
  targetNodeIds: string[];
}

/** 执行单个工具后的结果 */
export interface AgentToolResult {
  toolCallId: string;
  content: string;
  /** 本轮是否有画布变更（决定是否补一次历史快照） */
  mutated: boolean;
  /** 执行失败（缺参/目标不存在/校验失败/异常），用于操作行红叉展示 */
  failed?: boolean;
  /** 用户未勾选/拒绝而未执行（操作行灰叉「未执行」依据） */
  skipped?: boolean;
}

// ── 会话列表项 ──

export interface SessionListItem {
  id: string;
  title: string;
  updatedAt: string;
}
