/**
 * 全局加载态：汇聚动画——两圈青柠光环
 * 由外向内收拢、融进中心呼吸光核，多语言文案轻呼吸。
 * 当前用于画布页项目数据加载门。
 * 样式见 globals.css 的 canvas-loading-* 段。
 */
"use client";

import { useTranslation } from "react-i18next";

export default function LoadingPing() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-5 fixed inset-0 z-50 bg-[#151518] text-white">
      <div className="canvas-loading-mark" aria-hidden>
        <span className="canvas-loading-ring" />
        <span className="canvas-loading-ring canvas-loading-ring-late" />
        <span className="canvas-loading-core" />
      </div>
      <div className="text-lg canvas-loading-text">{t("common.loading")}</div>
    </div>
  );
}
