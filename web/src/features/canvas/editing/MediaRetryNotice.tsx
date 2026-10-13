/**
 * 媒体请求失败的原因提示与手动重试（截取 / 抽帧面板共用）。
 * 按错误码本地化原因（限流 / 个人名额 / 全站繁忙 / 生成失败）；响应带 Retry-After
 * 时倒计时结束前重试不可用——无退避的立即重试会放大过载，禁止自动重试。
 * 倒计时基准是错误自带的 receivedAt（事件时刻），渲染期不读时钟。
 */
"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { MediaRequestError } from "@/features/canvas/api/file-api";

interface MediaRetryNoticeProps {
  error: MediaRequestError;
  onRetry: () => void;
}

/** 纯内容（原因 + 重试按钮），定位由调用方的容器决定（轨道底部条 / 面板居中） */
export function MediaRetryNotice({ error, onRetry }: MediaRetryNoticeProps) {
  const { t } = useTranslation();
  const [now, setNow] = useState(0);

  const waiting = error.retryAfterSeconds != null;

  const elapsedSeconds = now === 0 ? 0 : Math.max(0, Math.floor((now - error.receivedAt) / 1000));
  const remainingSeconds = waiting
    ? Math.max(0, (error.retryAfterSeconds ?? 0) - elapsedSeconds)
    : 0;
  const counting = remainingSeconds > 0;
  // 倒计时归零即自停：interval 只在计数期间存在，不空转重渲染
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [counting]);
  const message = t(`error.${error.code}`, { defaultValue: t("error.unknown") });

  // 媒体信息条惯例：黑色半透明底 + 白色前景，不随主题切换（与缩略图信息条一致）
  return (
    <div className="pointer-events-auto flex items-center gap-2 rounded-md bg-black/65 px-2 py-1">
      <span className="text-xs text-white/85">{message}</span>
      <Button
        variant="ghost"
        className="h-5 rounded-sm px-1.5 text-[11px] text-white hover:bg-white/15 hover:text-white"
        disabled={counting}
        onClick={onRetry}
      >
        {counting ? t("media.retryIn", { seconds: remainingSeconds }) : t("media.retry")}
      </Button>
    </div>
  );
}
