/**
 * 一轮工具调用组：执行中强制展开逐条展示，全部完成后自动折叠为
 * 「执行了 N 个操作」单行（用户点击可再展开/收起）。
 */
"use client";

import { useState } from "react";

import ChatActionRow from "@/features/canvas/agent/components/ChatActionRow";
import type { ChatRound } from "@/features/canvas/agent/utils/group-sections";

interface Props {
  round: ChatRound;
  isStreaming: boolean;
}

export function ChatToolRound({ round, isStreaming }: Props) {
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
      <button type="button" className="chat-tool-round-toggle" onClick={() => setUserOpen(true)}>
        执行了 {round.calls.length} 个操作
        <span className="chat-tool-round-arrow">▸</span>
      </button>
    );
  }

  return (
    <div className="chat-tool-round">
      {round.calls.length > 1 && (
        <button type="button" className="chat-tool-round-toggle" onClick={() => setUserOpen(false)}>
          执行了 {round.calls.length} 个操作
          <span className="chat-tool-round-arrow">▾</span>
        </button>
      )}
      {round.calls.map((call) => (
        <ChatActionRow key={call.id} call={call} result={round.results.get(call.id)} isStreaming={isStreaming} />
      ))}
    </div>
  );
}

export default ChatToolRound;
