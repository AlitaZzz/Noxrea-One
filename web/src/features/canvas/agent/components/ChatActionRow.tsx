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
    <div className="flex w-fit max-w-full flex-wrap items-center gap-1.5 rounded-md bg-accent px-2 py-1.5 text-xs leading-none text-muted-foreground">
      <span className="inline-flex text-xs text-primary">{meta?.icon}</span>
      <Tooltip><TooltipTrigger asChild>
          <span className="max-w-[260px] overflow-hidden text-ellipsis whitespace-nowrap">{text}</span>
        </TooltipTrigger><TooltipContent side="top">{text}</TooltipContent></Tooltip>
      <span className={`inline-flex items-center gap-1 text-xs ${status === "error" ? "text-destructive" : status === "pending" ? "text-primary" : "text-muted-foreground"}`}>
        {status === "ok" && <CheckOutlined />}
        {status === "pending" && <LoadingOutlined spin />}
        {(status === "error" || status === "skipped") && <CloseOutlined />}
        {status === "skipped" && <span className="text-[11px] text-muted-foreground">{t("agent.skipped")}</span>}
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
      {detailOpen && <pre className="basis-full max-h-[180px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-card px-2 py-1.5 text-[11px] leading-6 text-muted-foreground">{pretty}</pre>}
    </div>
  );
}

export default ChatActionRow;
