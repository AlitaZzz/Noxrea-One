/**
 * Agent 消息上下文构建器。
 * 将历史消息、当前轮消息与技能内容组装为发给上游 LLM 的 messages 数组。
 * 采用分层注入策略：developer 层定义基础身份与工具规则，
 * system 层在有技能时注入领域知识，确保领域指令不覆盖基础身份。
 */

import type { ProtocolToolCall } from "@server/services/protocols/base";
import { getSkill } from "@server/services/capabilities/llm/skills/loader";

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

/** 从 DB 读出的历史消息（含 skills 标签） */
export interface HistoryMessage {
  role: string;
  content: string;
  skills?: string[] | null;
}

// Layer 1: 基础身份（developer 角色，最高优先级）

const BASE_IDENTITY = {
  role: "developer" as const,
  content:
    "你是 **Noxrea One Agent**，一个专注于图片、音频、视频生成与创作的智能助手。\n\n" +
    "无论是想要一段视频、一张概念图，还是一段配乐，都可以直接告诉我你的想法。我能帮你完成：\n" +
    "- 🎬 **视频生成**：给我故事、脚本或创意，我来拆分分镜、逐镜生成并最终合成成片\n" +
    "- 🖼️ **图片生成**：角色设定、场景概念图、关键帧等视觉内容\n" +
    "- 🎵 **音频生成**：配音、背景音乐、音效等声音内容\n" +
    "当用户询问你的身份或能力时，用简洁的 markdown 介绍上述信息即可。",
};

// Layer 2: 工具使用规则（developer 角色）

const TOOL_GUIDANCE = {
  role: "developer" as const,
  content:
    "## 工具使用规则\n" +
    "1. 对于用户的每一条消息，你最多只能发起一次工具调用，绝对不要在同一轮里调用两次或以上同一工具。\n" +
    "2. 不要为同一请求生成多个变体或多个选项，一次只创建一个节点。\n" +
    "3. 每条新的用户消息都是独立的一轮，不受之前是否调用过工具的影响。" +
    "即使用户上一轮已经生成过图片，本轮只要用户提出了生成意图，就应该正常调用对应工具。\n" +
    "4. 如果当前有技能（Skill）激活，优先遵循技能中的输出格式与流程要求。" +
    "技能未明确要求调用工具时，以纯文本输出设计方案，不要主动调用工具。",
};

/**
 * 组装最终发给上游 LLM 的 messages 数组。
 *
 * @param history    - 从 DB 读出的历史消息
 * @param incoming   - 前端发来的当前轮消息（含可能的 tool 续轮）
 * @param skills     - 显式触发的技能名列表
 * @param agent      - 是否为 agent 模式（注入 developer 层 + 工具）
 */
export function buildAgentMessages(opts: {
  history: HistoryMessage[];
  incoming: IncomingMessage[];
  skills?: string[];
  agent: boolean;
}): AgentMessage[] {
  const { history, incoming, agent } = opts;
  const skills = opts.skills ?? [];

  // Layer 3: Skill 领域知识（system 角色）
  const skillContents = skills
    .map((name) => getSkill(name))
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map((s) => s.content);
  const skillSystem: AgentMessage[] = skillContents.length
    ? [{ role: "system", content: skillContents.join("\n\n---\n\n") }]
    : [];

  // 历史过滤：按当前轮 skill 隔离上下文
  const filteredHistory = history.filter((m) => {
    const msgSkills = (m.skills as string[] | null) ?? [];
    if (skills.length === 0) {
      return msgSkills.length === 0;
    }
    return msgSkills.some((s) => skills.includes(s));
  });

  // 组装消息序列
  const messages: AgentMessage[] = [];

  // Layer 1 + 2: agent 模式时始终注入（不因 skill 激活而跳过）
  if (agent) {
    messages.push(BASE_IDENTITY, TOOL_GUIDANCE);
  }

  // Layer 3: skill 领域知识
  messages.push(...skillSystem);

  // 历史消息
  messages.push(
    ...filteredHistory.map((m) => ({ role: m.role, content: m.content })),
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
