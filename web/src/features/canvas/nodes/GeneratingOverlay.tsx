/**
 * 生成中占位浮层（GeneratingOverlay）。
 * 图片 / 文本 / 视频节点共用：暗色占位区内的显影扫光 + 青柠脉冲点 + 实时耗时。
 * 相位去同步：各动画用 startedAt 取模做负 animation-delay，
 * 多节点同时生成时不会齐刷刷同频齐动。
 * 通过 absolute / rounded 参数适配不同节点的容器布局。
 */
"use client";

import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/** 秒数格式化：59s 内 "12s"，超过 "1m05s" */
function formatElapsed(totalSeconds: number) {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, "0")}s`;
}

function GeneratingOverlay({
  text,
  absolute = true,
  rounded = false,
  startedAt,
}: {
  /** 自定义文案；缺省时使用通用「生成中」 */
  text?: string;
  /** 是否 absolute 定位铺满容器（Image/Text 用）；false 则用 w-full h-full（Video 用） */
  absolute?: boolean;
  /** 是否带圆角 */
  rounded?: boolean;
  /** 任务开始时间戳（ms）；传入时在文案后追加实时耗时，并用于动画相位去同步 */
  startedAt?: number;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    // 只在定时器回调里刷新：在 effect 体内同步 setState 会触发级联渲染。
    // startedAt 变化后最多 1s（下一个 tick）即可刷新，计时精度本身也是秒级。
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const elapsedSeconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : null;
  // 相位去同步：各动画周期不同，用 startedAt 对各自周期取模做负 delay
  const phaseMs = startedAt ?? 0;

  return (
    <div
      className={
        (absolute ? "absolute inset-0" : "w-full h-full relative") +
        (rounded ? " rounded-lg overflow-hidden" : "") +
        " flex flex-col items-center justify-center gap-2.5 overflow-hidden"
      }
      style={{ background: "var(--canvas-bg)" }}
    >
      {/* 扫光：淡斜向光带缓扫，像媒体显影 */}
      <div className="gen-shimmer" style={{ animationDelay: `-${phaseMs % 2800}ms` }} aria-hidden />
      {/* 中心：脉冲点 + 文案，保持安静 */}
      <span className="gen-pulse" style={{ animationDelay: `-${phaseMs % 1600}ms` }} aria-hidden />
      <span className="text-xs" style={{ color: "rgba(255,255,255,0.5)" }}>
        {text ?? t("common.generating")}
        {elapsedSeconds !== null && (
          <span className="tabular-nums" style={{ color: "rgba(255,255,255,0.35)" }}>
            {" · "}
            {formatElapsed(elapsedSeconds)}
          </span>
        )}
      </span>
    </div>
  );
}

export default memo(GeneratingOverlay);
