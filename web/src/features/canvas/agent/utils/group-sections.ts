/**
 * 聊天消息 → 回合（section）分组纯函数。
 * 一个回合 = 一条用户消息 + 随后的工具轮次（round）+ 确认结果条 + 助手文字气泡。
 * 旧历史消息（无 turnId）逐条独立成 section，tool 结果尽力归入含对应调用的 round。
 */
import type { ChatMessage, ToolCallView } from "@/features/canvas/agent/types";

export interface ChatRound {
  key: string;
  /** 本轮的画布工具调用（message_user 不渲染操作行，排除） */
  calls: ToolCallView[];
  /** toolCallId → tool 结果消息 */
  results: Map<string, ChatMessage>;
}

export interface ChatSection {
  key: string;
  /** 本回合的 turnId；旧历史消息为 null（不可撤销） */
  turnId: string | null;
  userMsg?: ChatMessage;
  rounds: ChatRound[];
  /** assistant 纯文字气泡（含错误提示） */
  texts: ChatMessage[];
  /** 确认卡决策结果条（不落库，刷新后消失） */
  confirmResult?: ChatMessage["confirmResult"];
  /** 本回合末尾有空的 assistant 占位（等待首个 delta/工具调用），渲染「思考中…」 */
  thinking?: boolean;
}

function newSection(key: string): ChatSection {
  return { key, turnId: null, rounds: [], texts: [] };
}

function findRoundWithCall(sections: ChatSection[], toolCallId: string): ChatRound | null {
  for (let i = sections.length - 1; i >= 0; i--) {
    for (const round of sections[i].rounds) {
      if (round.results.has(toolCallId) || round.calls.some((c) => c.id === toolCallId)) return round;
    }
  }
  return null;
}

export function groupSections(messages: ChatMessage[]): ChatSection[] {
  const sections: ChatSection[] = [];
  let current: ChatSection | null = null;

  const ensureCurrent = (): ChatSection => {
    if (!current) {
      current = newSection(`s-${sections.length}`);
      sections.push(current);
    }
    return current;
  };

  for (const m of messages) {
    if (m.role === "user") {
      current = {
        ...newSection(`s-${sections.length}`),
        turnId: m.turnId ?? null,
        userMsg: m,
      };
      sections.push(current);
      continue;
    }

    if (m.role === "assistant") {
      const calls = (m.toolCalls ?? []).filter((t) => t.name !== "message_user");
      const section = ensureCurrent();
      if (calls.length > 0) {
        section.rounds.push({ key: m.id, calls, results: new Map() });
      }
      if (m.content) {
        section.texts.push(m);
      } else if (calls.length === 0) {
        section.thinking = true;
      }
      continue;
    }

    if (m.role === "tool" && m.toolCallId) {
      const round = findRoundWithCall(sections, m.toolCallId);
      if (round) round.results.set(m.toolCallId, m);
      continue;
    }

    if (m.role === "system" && m.confirmResult) {
      ensureCurrent().confirmResult = m.confirmResult;
      continue;
    }
  }

  return sections;
}
