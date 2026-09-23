/**
 * Agent 消息上下文构建器（画布 Agent）。
 * 将历史消息、当前轮消息与画布状态快照组装为发给上游 LLM 的 messages 数组。
 * 分层注入：system 层定义画布 agent 身份与工具规则，再注入画布状态快照。
 *
 * 画布状态由前端随用户消息序列化上传（canvasSystem），续流轮次不重发——
 * 工具结果已告知 LLM 刚执行了什么。
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
  /** assistant 消息携带的工具调用（续流时需原样回填给上游） */
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }> | null;
}

// Layer 1: 身份（system 角色）

const BASE_IDENTITY = {
  role: "system" as const,
  content:
    "你是 **Noxrea One 画布助手**，运行在用户的 React Flow 创意画布上，通过工具直接操作画布节点。\n\n" +
    "你的能力：\n" +
    "- 查看并理解画布上已有的节点、连线与当前视口（画布状态会以 JSON 注入）\n" +
    "- 创建文本 / 图片 / 视频 / 音频 / 导演台 / 编组节点，可批量创建并连线\n" +
    "- 更新、删除、移动、选中节点，整理布局，控制视口\n" +
    "- 图片/视频节点只会被预填生成提示词，内容生成由用户自行触发——你无法直接生成图片/视频成品\n\n" +
    "与用户交流用简洁的 markdown；操作完成后必须调用 message_user 说明结果。",
};

// Layer 2: 工具使用规则（system 角色）

const TOOL_GUIDANCE = {
  role: "system" as const,
  content:
    "## 工具使用规则\n" +
    "1. 画布状态里的节点 id 是唯一凭证：更新 / 连线 / 删除都必须引用真实存在的 id，不要凭空捏造。\n" +
    "2. 修改已有内容优先用 update_node，而不是删除重建；连接已有节点用 connect_nodes。\n" +
    "3. create_node 支持一次批量创建任意数量的节点，全部条目放在一次调用里，不要分批；同批次连线可用序号（\"1\"）引用同批节点。\n" +
    "4. create_node 已按批次自动排布新节点，创建后无需再排版；仅当需要重排画布上已有内容时调用 arrange_canvas，不要手动计算节点坐标。需要展示某节点时用 set_viewport 或 select_nodes。\n" +
    "5. 一轮内如需多个工具调用，按依赖顺序逐轮发起：先创建拿到 id，再连线 / 更新。\n" +
    "6. 全部操作完成后调用 message_user 简要总结，然后停止——message_user 的内容就是给用户的唯一回复，之后不要输出任何文字。\n" +
    "   总结不超过 3 句；不要复述 prompt/content 全文，不要罗列提示词要点，给一句下一步建议即可。\n" +
    "7. 工具执行失败时，阅读错误信息修正参数重试一次；仍失败则用 message_user 告知用户，不要无限重试。",
};

/** 画布状态快照注入消息的最大长度（超出截断，防 token 爆炸） */
const CANVAS_SYSTEM_MAX_CHARS = 12_000;

/**
 * 把前端上传的画布状态序列化结果包装为 system 消息。
 * 前端已做紧凑化与节点数截断，这里只做兜底长度限制。
 */
export function buildCanvasSystem(canvasState: unknown): string | null {
  if (canvasState == null) return null;
  let json: string;
  try {
    json = JSON.stringify(canvasState);
  } catch {
    return null;
  }
  if (!json || json === "{}" || json === "[]") return null;
  if (json.length > CANVAS_SYSTEM_MAX_CHARS) {
    json = json.slice(0, CANVAS_SYSTEM_MAX_CHARS) + "…(画布过大，状态已截断)";
  }
  return "## 当前画布状态\n```json\n" + json + "\n```";
}

/**
 * 组装最终发给上游 LLM 的 messages 数组。
 *
 * @param history      - 从 DB 读出的历史消息（assistant 消息可能带 toolCalls，需回填）
 * @param incoming     - 当前轮消息（用户消息或工具结果续轮）
 * @param canvasSystem - 画布状态 system 消息（仅用户消息轮传入）
 */
export function buildAgentMessages(opts: {
  history: HistoryMessage[];
  incoming: IncomingMessage[];
  canvasSystem?: string | null;
}): AgentMessage[] {
  const { history, incoming, canvasSystem } = opts;

  const messages: AgentMessage[] = [BASE_IDENTITY, TOOL_GUIDANCE];

  if (canvasSystem) {
    messages.push({ role: "system", content: canvasSystem });
  }

  // 历史消息（全量）。assistant 的 tool_calls 原样回填，上游才能接受后续 tool 消息；
  // 但末尾悬空的 tool_calls（工具轮数打满/中途中断时落库，没有对应的 tool 回复）
  // 必须丢弃，否则上游会以「tool_calls 缺少 tool 响应」拒绝整次请求。
  messages.push(
    ...history.map((m, i) => {
      const msg: AgentMessage = { role: m.role, content: m.content };
      if (m.toolCallId) msg.toolCallId = m.toolCallId;
      if (m.toolCalls?.length) {
        const next = history[i + 1];
        const answered = next?.role === "tool" && m.toolCalls.some((t) => t.id === next.toolCallId);
        if (answered) msg.toolCalls = m.toolCalls;
      }
      return msg;
    }),
  );

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
