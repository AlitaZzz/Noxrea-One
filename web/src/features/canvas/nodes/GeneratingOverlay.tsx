/**
 * 生成中占位浮层（GeneratingOverlay）。
 * 图片 / 文本 / 视频 / 音频节点共用：纯色深底（#1f1f1f）+ 颗粒漂浮 + 文字流光 +
 * 文案 / 实时耗时。颗粒只动 transform（交给合成器），文字流光仅重绘文案小面积；
 * 相位由 startedAt 取模做负 delay，多节点同时生成时不同频。
 * 不做极光带、中心光晕、大范围模糊与进度条。
 * 通过 absolute 参数适配不同节点的容器布局。
 */
"use client";

import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatElapsed } from "@/lib/utils/format-elapsed";

function GeneratingOverlay({
  text,
  absolute = true,
  startedAt,
}: {
  /** 自定义文案；缺省时使用通用「生成中」 */
  text?: string;
  /** 是否 absolute 定位铺满容器（Image/Text 用）；false 则用 w-full h-full（Video/Audio 用） */
  absolute?: boolean;
  /** 任务开始时间戳（ms）；传入时在文案后追加实时耗时 */
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

  return (
    <div
      className={
        (absolute ? "absolute inset-0" : "w-full h-full relative") +
        " gen-stage rounded-lg flex items-center justify-center overflow-hidden"
      }
    >
      <div
        className="gen-grain"
        style={{ animationDelay: `-${(startedAt ?? 0) % 30000}ms` }}
        aria-hidden
      />
      <span className="relative text-xs text-white/80">
        <span
          className="gen-text-shimmer"
          style={{ animationDelay: `-${(startedAt ?? 0) % 5000}ms` }}
        >
          {text ?? t("common.generating")}
        </span>
        {elapsedSeconds !== null && (
          <span className="tabular-nums text-white/60">
            {" · "}
            {formatElapsed(elapsedSeconds)}
          </span>
        )}
      </span>
    </div>
  );
}

export default memo(GeneratingOverlay);
