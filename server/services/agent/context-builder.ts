/**
 * Agent 消息上下文构建器（画布 Agent）。
 * 将历史消息、当前轮消息与画布状态快照组装为发给上游 LLM 的 messages 数组。
 * 分层注入：system 层定义画布 agent 身份与工具规则，再注入画布状态快照。
 *
 * 画布状态由前端序列化上传（canvasSystem），用户消息轮与工具结果续轮都重发，
 * 保证模型在任何一轮看到的都是画布此刻的最新状态；历史只回放文本对话，
 * 旧工具轮的 tool_calls / tool 结果不回放（其中的 id 与选择状态早已过期）。
 */

import type { ProtocolToolCall } from "@server/services/protocols/base";

/** 组装后发给上游的消息条目 */
export type AgentMessage = {
  role: string;
  content: string;
  images?: string[];
  toolCalls?: ProtocolToolCall[];
  toolCallId?: string;
};

/** 前端发来的当前轮消息 */
export interface IncomingMessage {
  role: string;
  content: string;
  images?: string[];
  toolCalls?: ProtocolToolCall[];
  toolCallId?: string;
}

/** 从 DB 读出的历史消息 */
export interface HistoryMessage {
  role: string;
  content: string;
  toolCallId?: string | null;
  toolName?: string | null;
  /** assistant 消息携带的工具调用（仅当前轮 tool 结果的应答会被回填，其余不回放） */
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }> | null;
}

// Layer 1: 身份（system 角色）

const BASE_IDENTITY = {
  role: "system" as const,
  content:
    "你是 **Noxrea One 画布助手**，运行在用户的 React Flow 创意画布上，通过工具直接操作画布节点。\n\n" +
    "你的能力：\n" +
    "- 查看并理解画布上已有的节点、连线与当前视口（画布状态会以 JSON 注入）\n" +
    "- 随时调用 get_canvas_state 读取画布最新名册，用 get_node_detail 读取节点完整内容（正文/提示词，拿不准时先读再操作）\n" +
    "- 创建文本 / 图片 / 视频 / 音频 / 导演台 / 编组节点，可批量创建并连线\n" +
    "- 更新、删除、复制节点，删除连线，移动、选中节点，整理布局，控制视口\n" +
    "- 图片/视频节点只会被预填生成提示词，内容生成由用户自行触发——你无法直接生成图片/视频成品\n\n" +
    "与用户交流用简洁的 markdown；操作完成后必须调用 message_user 说明结果。",
};

// Layer 2: 工具使用规则（system 角色）

const TOOL_GUIDANCE = {
  role: "system" as const,
  content:
    "## 工具使用规则\n" +
    "1. 画布状态里的节点 id 是唯一凭证：更新 / 连线 / 删除都必须引用当前画布状态或工具结果中真实存在的 id，" +
    "不要凭空捏造，也不要使用历史消息里出现过的旧 id（节点可能已被删除或重建）。\n" +
    "2. 画布状态以紧邻当前消息注入的最新快照为唯一权威：历史消息里任何「选中了 X」「节点内容是 Y」的描述都已过期，不要引用；对状态拿不准时再调用 get_canvas_state。\n" +
    "3. 用户询问画布当前状态类问题（有哪些节点、当前选中了什么、某节点的位置/尺寸/连线）时，直接依据最新注入的快照回答；" +
    "快照带 truncated 标记或你不确定时，先调用 get_canvas_state 核实。\n" +
    "4. 注入的画布名册不含节点内容（正文与提示词）。凡涉及节点内容的读取、总结、引用或修改，" +
    "必须先调用 get_node_detail 读取完整内容（可批量传多个 nodeIds），不要凭节点标题猜测内容，也不要对截断的旧摘要做编辑。\n" +
    "5. 修改已有内容优先用 update_node，而不是删除重建；连接已有节点用 connect_nodes。\n" +
    "6. create_node 支持一次批量创建任意数量的节点，全部条目放在一次调用里，不要分批；同批次连线可用序号（\"1\"）引用同批节点。\n" +
    "7. create_node 已按批次自动排布新节点，创建后无需再排版；仅当需要重排画布上已有内容时调用 arrange_canvas，不要手动计算节点坐标。需要展示某节点时用 set_viewport 或 select_nodes。\n" +
    "8. 一轮内如需多个工具调用，按依赖顺序逐轮发起：先创建拿到 id，再连线 / 更新。\n" +
    "9. 全部操作完成后调用 message_user 简要总结，然后停止——message_user 的内容就是给用户的唯一回复，之后不要输出任何文字。\n" +
    "   总结不超过 3 句；不要复述 prompt/content 全文，不要罗列提示词要点，给一句下一步建议即可。\n" +
    "10. 工具执行失败时，阅读错误信息修正参数重试一次；仍失败则用 message_user 告知用户，不要无限重试。" +
    "如实汇报工具结果，不要编造或假设操作已成功。\n" +
    "11. delete_nodes / delete_edges / arrange_canvas 提交后会先向用户请求确认（删除类可逐条勾选要执行的目标）：用户确认才执行，拒绝时结果是「用户拒绝了此操作」——" +
    "此时不要换方式重试或绕过，直接用 message_user 询问用户的顾虑即可。\n" +
    "12. 每次调用工具时 intent 字段必填：用一句中文（10~30 字，动词开头）说明这次操作要做什么，会原样展示给用户，不要写工具名或参数细节。",
};

/** 画布状态快照注入消息的最大长度（结构性截断，防 token 爆炸） */
const CANVAS_SYSTEM_MAX_CHARS = 12_000;

/** 结构性截断的保底行数：再多也不会砍到零，超出则走兜底字符串截断 */
const MIN_KEEP_NODES = 20;
const MIN_KEEP_EDGES = 100;
const MAX_SELECTION_IDS = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 结构性截断：按节点/连线整条丢弃并给出剩余计数，绝不产生被切一半的 JSON。
 * 前端保证选中节点排在 nodes 最前，因此按序保留即可优先留下选中节点。
 * 返回截断后的对象与提示语（未截断时提示语为 null）。
 */
function structurallyTruncateCanvas(
  state: Record<string, unknown>
): { state: Record<string, unknown>; note: string | null } {
  const nodes = Array.isArray(state.nodes) ? state.nodes : [];
  const edges = Array.isArray(state.edges) ? state.edges : [];
  const selection = Array.isArray(state.selection) ? state.selection.filter((v) => typeof v === "string") : [];
  const selectionNote = selection.length > MAX_SELECTION_IDS
    ? `${selection.length - MAX_SELECTION_IDS} 个选中节点 id 未列出`
    : null;

  const sizeOf = (o: Record<string, unknown>) => JSON.stringify(o).length;
  let nodeLimit = nodes.length;
  let edgeLimit = edges.length;
  const assemble = (): Record<string, unknown> => ({
    ...state,
    ...(selection.length > MAX_SELECTION_IDS ? { selection: selection.slice(0, MAX_SELECTION_IDS) } : {}),
    nodes: nodes.slice(0, nodeLimit),
    edges: edges.slice(0, edgeLimit),
  });

  // 交替收缩连线与节点配额（对半），直到塞得下或到达保底
  while (sizeOf(assemble()) > CANVAS_SYSTEM_MAX_CHARS && (edgeLimit > MIN_KEEP_EDGES || nodeLimit > MIN_KEEP_NODES)) {
    if (edgeLimit > MIN_KEEP_EDGES) edgeLimit = Math.max(MIN_KEEP_EDGES, Math.floor(edgeLimit / 2));
    else nodeLimit = Math.max(MIN_KEEP_NODES, Math.floor(nodeLimit / 2));
  }
  let trimmed = assemble();

  let note: string | null = null;
  const parts: string[] = [];
  if (nodeLimit < nodes.length) parts.push(`${nodes.length - nodeLimit} 个节点未列出`);
  if (edgeLimit < edges.length) parts.push(`${edges.length - edgeLimit} 条连线未列出`);
  if (selectionNote) parts.push(selectionNote);
  if (parts.length > 0) {
    note = `画布过大，已截断：${parts.join("，")}。需要完整列表时调用 get_canvas_state 逐段核实。`;
    trimmed = { ...trimmed, truncated: note };
  }

  // 兜底：保底配额内仍超长（异常超大节点条目）才做字符串截断
  let json = JSON.stringify(trimmed);
  if (json.length > CANVAS_SYSTEM_MAX_CHARS) {
    json = json.slice(0, CANVAS_SYSTEM_MAX_CHARS) + "…(画布过大，状态已截断)";
  }
  return { state: trimmed, note };
}

/**
 * 把前端上传的画布状态序列化结果包装为 system 消息。
 * 前端名册不含节点内容（content/prompt），超出长度时做结构性截断并附剩余计数。
 * 文案明确 selection/selected 字段语义与快照时效：历史消息里的旧选择/坐标一律不采信。
 */
export function buildCanvasSystem(canvasState: unknown): string | null {
  if (canvasState == null) return null;
  if (!isRecord(canvasState)) return null;
  let json: string;
  try {
    json = JSON.stringify(structurallyTruncateCanvas(canvasState).state);
  } catch {
    return null;
  }
  if (!json || json === "{}" || json === "[]") return null;
  return (
    "## 当前画布状态（节点名册）\n```json\n" + json + "\n```\n" +
    "字段说明：本名册只含节点的结构性信息（id/类型/位置/尺寸/标题），不含节点内容（正文 content 与提示词 prompt）；" +
    "需要节点完整内容时调用 get_node_detail 读取，不要凭标题猜测内容。" +
    "selection 数组与节点上的 selected: true 是此刻的最新选择。" +
    "本快照紧邻当前用户消息注入，是画布状态的唯一权威依据：历史消息中出现过的选择、坐标与内容描述一律视为已过期，不要引用；" +
    "只有当快照带 truncated 截断标记时，才需要调用 get_canvas_state 补全。"
  );
}

/** 用户操作 system 消息的最大长度（超出截断，防 token 爆炸） */
const USER_ACTIONS_MAX_CHARS = 6_000;

/**
 * 把前端上报的用户操作 diff 包装为 system 消息（仅在有变更时注入）。
 * 描述两次请求之间用户对画布做的增量操作；与画布状态快照冲突时以快照为准。
 */
export function buildUserActionSystem(userActions: unknown): string | null {
  if (userActions == null) return null;
  let json: string;
  try {
    json = JSON.stringify(userActions);
  } catch {
    return null;
  }
  if (!json || json === "{}" || json === '{"added":[],"removed":[],"updated":[],"edges":{"added":[],"removed":[]}}') {
    return null;
  }
  if (json.length > USER_ACTIONS_MAX_CHARS) {
    json = json.slice(0, USER_ACTIONS_MAX_CHARS) + "…(变更过多，已截断)";
  }
  return (
    "## 自上一条消息以来的画布变更\n```json\n" + json + "\n```\n" +
    "以上是用户在两次消息之间对画布做出的操作（新增/删除/修改节点或连线）。"
  );
}

/**
 * 组装最终发给上游 LLM 的 messages 数组。
 *
 * @param history      - 从 DB 读出的历史消息（只回放文本对话，旧工具轮细节不回放）
 * @param incoming     - 当前轮消息（用户消息或工具结果续轮）
 * @param canvasSystem - 画布状态 system 消息（用户消息轮与工具结果续轮都传入）
 * @param userActionSystem - 用户操作 diff system 消息（有变更时传入，跟在画布状态之后）
 */
export function buildAgentMessages(opts: {
  history: HistoryMessage[];
  incoming: IncomingMessage[];
  canvasSystem?: string | null;
  userActionSystem?: string | null;
}): AgentMessage[] {
  const { history, incoming, canvasSystem, userActionSystem } = opts;

  const messages: AgentMessage[] = [BASE_IDENTITY, TOOL_GUIDANCE];

  // 历史瘦身：只回放文本对话。旧工具轮的 tool_calls 与 tool 结果不回放——
  // 其中的节点 id、选择状态早已过期，是模型引用错误 id / 旧选择的主要来源。
  // 唯一例外：当前轮 incoming 工具结果所应答的 assistant tool_calls 必须保留，
  // 否则上游会以「tool 结果缺少对应的 tool_calls」拒绝整次请求。
  const incomingToolIds = new Set(
    incoming.filter((m) => m.role === "tool" && m.toolCallId).map((m) => m.toolCallId as string),
  );

  const historyMessages: AgentMessage[] = [];
  for (const m of history) {
    if (m.role === "tool") continue;
    const msg: AgentMessage = { role: m.role, content: m.content };
    if (m.role === "assistant" && m.toolCalls?.length && incomingToolIds.size > 0) {
      // 只保留当前轮有结果应答的调用，防止悬空 tool_calls 被上游拒绝
      const answered = m.toolCalls.filter((t) => incomingToolIds.has(t.id));
      if (answered.length > 0) msg.toolCalls = answered;
    }
    // 工具轮 assistant 常无正文：剥离 toolCalls 后成空壳，跳过避免噪音
    if (msg.role === "assistant" && !msg.content && !msg.toolCalls) continue;
    historyMessages.push(msg);
  }
  messages.push(...historyMessages);

  // 画布快照放在历史之后、当前消息之前（而不是最开头）：
  // 历史里「你当前选中了 X」之类的旧状态描述离当前问题更近，
  // 弱模型会按近因偏好抄历史旧答案而无视开头的快照——
  // 把唯一权威的最新快照紧贴当前消息注入， 近因偏好反而成为正确性来源。
  if (canvasSystem) {
    messages.push({ role: "system", content: canvasSystem });
  }
  if (userActionSystem) {
    messages.push({ role: "system", content: userActionSystem });
  }

  // 当前轮消息
  messages.push(
    ...incoming.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.images?.length ? { images: m.images } : {}),
      ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    })),
  );

  return messages;
}
