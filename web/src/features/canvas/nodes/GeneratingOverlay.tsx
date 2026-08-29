/**
 * 生成中占位浮层（GeneratingOverlay）。
 * 图片 / 文本 / 视频节点共用：蓝色径向呼吸光晕 + 绿色旋转加载圈 + 生成中文案 + 实时耗时。
 * 统一以 ImageNode 的视觉为准（绿色 spinner、gap-3、text-white/50）。
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
  /** 任务开始时间戳（ms）；传入时在文案后追加实时耗时 */
  startedAt?: number;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const elapsedSeconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : null;

  return (
    <div
      className={
        (absolute ? "absolute inset-0" : "w-full h-full relative") +
        (rounded ? " rounded-lg overflow-hidden" : "") +
        " flex flex-col items-center justify-center gap-3 overflow-hidden"
      }
      style={{ background: "var(--canvas-bg)" }}
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% 45%, rgba(59,130,246,0.35), transparent 70%)",
          animation: "breathe 3s ease-in-out infinite",
        }}
      />
      <div
        className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
        style={{ borderColor: "#1D9E75", borderTopColor: "transparent" }}
      />
      <span className="text-sm text-white/50">
        {text ?? t("common.generating")}
        {elapsedSeconds !== null && (
          <span className="text-white/35"> · {formatElapsed(elapsedSeconds)}</span>
        )}
      </span>
    </div>
  );
}

export default memo(GeneratingOverlay);
