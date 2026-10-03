/**
 * 一轮工具调用组：执行中强制展开逐条展示，全部完成后自动折叠为
 * 「执行了 N 个操作」单行（用户点击可再展开/收起）。
 */
"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CaretDownOutlined, CaretRightOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import ChatActionRow from "@/features/canvas/agent/components/ChatActionRow";
import type { ChatRound } from "@/features/canvas/agent/utils/group-sections";

interface Props {
  round: ChatRound;
  isStreaming: boolean;
}

export function ChatToolRound({ round, isStreaming }: Props) {
  const { t } = useTranslation();
  const allDone = !isStreaming && round.calls.every((c) => round.results.has(c.id));
  // null = 用户未干预：未完成展开、完成后折叠；用户点击后固定
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !allDone;

  // 单条调用无需折叠容器，直接渲染操作行
  if (round.calls.length === 1) {
    const call = round.calls[0];
    return <ChatActionRow call={call} result={round.results.get(call.id)} isStreaming={isStreaming} />;
  }

  if (!open) {
    return (
      <Button type="button" variant="secondary" size="xs" className="w-fit" onClick={() => setUserOpen(true)}>
        {t("agent.executedCount", { count: round.calls.length })}
        <CaretRightOutlined className="size-3 opacity-70" aria-hidden="true" />
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {round.calls.length > 1 && (
        <Button type="button" variant="secondary" size="xs" className="w-fit" onClick={() => setUserOpen(false)}>
          {t("agent.executedCount", { count: round.calls.length })}
          <CaretDownOutlined className="size-3 opacity-70" aria-hidden="true" />
        </Button>
      )}
      {round.calls.map((call) => (
        <ChatActionRow key={call.id} call={call} result={round.results.get(call.id)} isStreaming={isStreaming} />
      ))}
    </div>
  );
}

export default ChatToolRound;
