/**
 * 单条工具操作行：图标 + intent 一句话 + 执行状态（spinner/对勾/红叉/灰叉「未执行」），
 * 行尾「详情」展开原始参数或结果文本（给用户核对，不给模型看的部分已隐藏）。
 */
"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CheckOutlined, CloseOutlined, LoadingOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { actionRowText, TOOL_META } from "@/features/canvas/agent/tools/Meta";
import type { ChatMessage, ToolCallView } from "@/features/canvas/agent/types";

/** 详情预览的最大字符数（get_canvas_state 的大 JSON 截断展示） */
const DETAIL_MAX_CHARS = 4000;

interface Props {
  call: ToolCallView;
  result?: ChatMessage;
  isStreaming: boolean;
}

export function ChatActionRow({ call, result, isStreaming }: Props) {
  const { t } = useTranslation();
  const [detailOpen, setDetailOpen] = useState(false);
  const meta = TOOL_META[call.name];
  const text = actionRowText(call);

  const status = result
    ? result.failed
      ? "error"
      : result.skipped
        ? "skipped"
        : "ok"
    : isStreaming
      ? "pending"
      : "skipped";

  const rawDetail = result?.content ?? call.args;
  const detail = rawDetail.length > DETAIL_MAX_CHARS ? `${rawDetail.slice(0, DETAIL_MAX_CHARS)}${t("agent.detailTruncated")}` : rawDetail;
  let pretty = detail;
  if (!result?.content) {
    try {
      pretty = JSON.stringify(JSON.parse(detail), null, 2);
    } catch { /* 非 JSON 原样展示 */ }
  }

  return (
    <div className="chat-action-row">
      <span className="chat-action-icon">{meta?.icon}</span>
      <Tooltip><TooltipTrigger asChild>
          <span className="chat-action-text">{text}</span>
        </TooltipTrigger><TooltipContent side="top">{text}</TooltipContent></Tooltip>
      <span className={`chat-action-status${status === "error" ? " is-error" : ""}${status === "pending" ? " is-pending" : ""}`}>
        {status === "ok" && <CheckOutlined />}
        {status === "pending" && <LoadingOutlined spin />}
        {(status === "error" || status === "skipped") && <CloseOutlined />}
        {status === "skipped" && <span className="chat-action-skip-text">{t("agent.skipped")}</span>}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="shrink-0 opacity-70"
        onClick={() => setDetailOpen((v) => !v)}
      >
        {detailOpen ? t("common.collapse") : t("agent.detail")}
      </Button>
      {detailOpen && <pre className="chat-tool-detail">{pretty}</pre>}
    </div>
  );
}

export default ChatActionRow;
