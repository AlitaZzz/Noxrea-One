/**
 * 本地处理忙浮层（BusyOverlay）。
 * 视频节点（抽帧 / 分离音频 / 片段截取 / 画面裁剪）与音频节点（音频截取 /
 * 音频变速）的本地处理操作统一反馈：暗色遮罩 + spinner + 操作文案 + 实时耗时；
 * 客户端管线任务额外支持进度百分比与取消。
 * 与 AI 生成的 GeneratingOverlay 是两种语言：这里反馈的是本地处理。
 */
"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { formatElapsed } from "@/lib/utils/format-elapsed";

export default function BusyOverlay({
  label,
  startedAt,
  progress,
  onCancel,
}: {
  /** 操作文案，如「正在截取片段...」 */
  label: string;
  /** 操作开始时间戳（ms），驱动实时耗时 */
  startedAt: number;
  /** 客户端管线进度（0–100）；无进度（服务端路径）不显示 */
  progress?: number;
  /** 客户端任务的取消入口；服务端同步长请求不支持取消时不传 */
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  // 秒级计时：只在定时器回调里刷新，避免 effect 体内同步 setState 级联渲染
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 rounded-lg bg-black/45"
    >
      <span className="w-7 h-7 rounded-full border-2 border-white/80 border-t-transparent animate-spin" />
      <span className="text-xs text-white/80">
        {label}
        <span className="tabular-nums text-white/60">
          {" · "}
          {formatElapsed(elapsed)}
        </span>
        {progress != null && (
          <span className="tabular-nums text-white/60">{` · ${progress}%`}</span>
        )}
      </span>
      {onCancel && (
        <Button
          size="sm"
          variant="secondary"
          className="h-6 px-2 text-[11px]"
          // stopPropagation 阻止 React Flow 把按下后的移动接管为节点拖拽并吞掉
          // click（与 VideoControls 控件的 onPointerDown stopPropagation 同一约定）
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onCancel}
        >
          {t("common.cancel")}
        </Button>
      )}
    </div>
  );
}
