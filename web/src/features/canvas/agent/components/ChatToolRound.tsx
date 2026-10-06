/**
 * 一轮工具调用组：执行中强制展开逐条展示，全部完成后自动折叠为
 * 「执行了 N 个操作」单行（用户点击可再展开/收起）。
 */
"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CaretDownOutlined, CaretRightOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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

  return (
    <Collapsible open={open} onOpenChange={setUserOpen} className="flex flex-col gap-1">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="secondary" size="xs" className="w-fit">
          {t("agent.executedCount", { count: round.calls.length })}
          {open ? <CaretDownOutlined aria-hidden="true" /> : <CaretRightOutlined aria-hidden="true" />}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1">
        {round.calls.map((call) => (
          <ChatActionRow key={call.id} call={call} result={round.results.get(call.id)} isStreaming={isStreaming} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export default ChatToolRound;
