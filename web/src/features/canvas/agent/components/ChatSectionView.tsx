/**
 * 一个对话回合的渲染：用户气泡 → 工具轮次（操作行）→ 确认结果条 → 助手文字 → 撤销按钮。
 */
"use client";

import { useTranslation } from "react-i18next";

import { UndoTurnIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
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
  const { t } = useTranslation();
  return (
    <div className="mb-4 flex flex-col text-sm leading-[1.55]">
      {section.userMsg && (
        <div className="mb-3 flex justify-end">
          <div className="max-w-[88%] break-words whitespace-pre-wrap rounded-xl rounded-br-sm bg-secondary px-3 py-[9px] text-secondary-foreground">
            <div className="cortex-markdown">{section.userMsg.content ? <Markdown>{section.userMsg.content}</Markdown> : null}</div>
          </div>
        </div>
      )}

      {section.rounds.length > 0 && (
        <div className="mb-1.5 flex flex-col gap-1">
          {section.rounds.map((round) => (
            <ChatToolRound key={round.key} round={round} isStreaming={isStreaming} />
          ))}
        </div>
      )}

      {section.confirmResult && (
        <div className={`mb-2 w-fit max-w-[88%] rounded-lg px-2.5 py-1.5 text-xs leading-[1.4] ${section.confirmResult.approved ? "bg-accent text-muted-foreground" : "bg-destructive/10 text-destructive"}`}>
          {section.confirmResult.approved
            ? section.confirmResult.skippedCount > 0
              ? t("agent.confirmExecuted", { executed: section.confirmResult.executedCount, skipped: section.confirmResult.skippedCount })
              : t("agent.confirmExecutedAll", { executed: section.confirmResult.executedCount })
            : t("agent.confirmCancelled")}
        </div>
      )}

      {section.texts.map((m) => (
        <div
          key={m.id}
          className="mb-3 flex justify-start"
        >
          <div className={`max-w-[88%] break-words whitespace-pre-wrap rounded-xl rounded-bl-sm bg-popover px-3 py-[9px] text-foreground ${m.error ? "border border-destructive/50 bg-destructive/15 text-destructive" : ""}`}>
            <Markdown>{m.content}</Markdown>
          </div>
        </div>
      ))}

      {section.thinking && isStreaming && (
        <div className="mb-3 flex justify-start">
          <div className="max-w-[88%] break-words whitespace-pre-wrap rounded-xl rounded-bl-sm bg-popover px-3 py-[9px] text-foreground">
            <span className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
              <span className="size-3.5 animate-spin rounded-full border-2 border-input border-t-primary" aria-hidden="true" />
              {t("agent.thinking")}
            </span>
          </div>
        </div>
      )}

      {canUndo && (
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onUndo}>
          <UndoTurnIcon />
          <span>{t("agent.undoTurn")}</span>
        </Button>
      )}
    </div>
  );
}

export default ChatSectionView;
