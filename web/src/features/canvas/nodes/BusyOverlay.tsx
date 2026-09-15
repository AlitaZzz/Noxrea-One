/**
 * 本地处理忙浮层（BusyOverlay）。
 * 视频节点的 ffmpeg 类同步操作（抽帧 / 分离音频 / 片段截取）统一反馈：
 * 暗色遮罩 + spinner + 操作文案 + 实时耗时。
 * 与 AI 生成的 GeneratingOverlay 是两种语言：这里反馈的是本地处理。
 */
"use client";

import { useEffect, useState } from "react";

/** 秒数格式化：59s 内 "47s"，超过 "1m05s"（与 GeneratingOverlay 同款式） */
function formatElapsed(totalSeconds: number) {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, "0")}s`;
}

export default function BusyOverlay({
  label,
  startedAt,
}: {
  /** 操作文案，如「正在截取片段...」 */
  label: string;
  /** 操作开始时间戳（ms），驱动实时耗时 */
  startedAt: number;
}) {
  const [now, setNow] = useState(() => Date.now());

  // 秒级计时：只在定时器回调里刷新，避免 effect 体内同步 setState 级联渲染
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 rounded-lg"
      style={{ background: "rgba(0,0,0,0.45)" }}
    >
      <span className="w-7 h-7 rounded-full border-2 border-white/80 border-t-transparent animate-spin" />
      <span className="text-xs text-white/80">
        {label}
        <span className="tabular-nums text-white/60">
          {" · "}
          {formatElapsed(elapsed)}
        </span>
      </span>
    </div>
  );
}
