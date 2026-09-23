/**
 * 一个对话回合的渲染：用户气泡 → 工具轮次（操作行）→ 确认结果条 → 助手文字 → 撤销按钮。
 */
"use client";

import { UndoTurnIcon } from "@/components/ui/icons/agent/UndoTurnIcon";
import ChatToolRound from "@/features/canvas/agent/components/ChatToolRound";
import Markdown from "@/features/canvas/agent/components/Markdown";
import type { ChatSection } from "@/features/canvas/agent/utils/group-sections";

interface Props {
  section: ChatSection;
  isStreaming: boolean;
  /** 是否渲染「撤销此轮」按钮（由调用方按 turnId 与历史版本判定） */
  canUndo: boolean;
  onUndo: () => void;
}

export function ChatSectionView({ section, isStreaming, canUndo, onUndo }: Props) {
  return (
    <div className="chat-section">
      {section.userMsg && (
        <div className="chat-msg chat-msg-user" style={{ marginBottom: 12, display: "flex", justifyContent: "flex-end" }}>
          <div className="chat-bubble chat-bubble-user">
            <div className="cortex-markdown">{section.userMsg.content ? <Markdown>{section.userMsg.content}</Markdown> : null}</div>
          </div>
        </div>
      )}

      {section.rounds.length > 0 && (
        <div className="chat-tool-calls">
          {section.rounds.map((round) => (
            <ChatToolRound key={round.key} round={round} isStreaming={isStreaming} />
          ))}
        </div>
      )}

      {section.confirmResult && (
        <div className={`chat-confirm-result ${section.confirmResult.approved ? "chat-confirm-result-ok" : "chat-confirm-result-deny"}`}>
          {section.confirmResult.approved
            ? `已确认执行 ${section.confirmResult.executedCount} 项操作${section.confirmResult.skippedCount > 0 ? `，跳过 ${section.confirmResult.skippedCount} 项` : ""}`
            : "已取消，未执行任何操作"}
        </div>
      )}

      {section.texts.map((m) => (
        <div
          key={m.id}
          className="chat-msg chat-msg-assistant"
          style={{ marginBottom: 12, display: "flex", justifyContent: "flex-start" }}
        >
          <div className={`chat-bubble chat-bubble-assistant${m.error ? " chat-bubble-error" : ""}`}>
            <Markdown>{m.content}</Markdown>
          </div>
        </div>
      ))}

      {section.thinking && isStreaming && (
        <div className="chat-msg chat-msg-assistant" style={{ marginBottom: 12, display: "flex", justifyContent: "flex-start" }}>
          <div className="chat-bubble chat-bubble-assistant">
            <span className="chat-thinking">思考中…</span>
          </div>
        </div>
      )}

      {canUndo && (
        <button type="button" className="chat-section-undo-btn" onClick={onUndo}>
          <UndoTurnIcon />
          <span>撤销此轮</span>
        </button>
      )}
    </div>
  );
}

export default ChatSectionView;
