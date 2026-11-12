"use client";

import { Background, BackgroundVariant, useStore } from "@xyflow/react";
import { memo } from "react";

/**
 * 画布点阵：参数与即梦 canvas-dot-grid 对齐（2026-11-11）。
 *
 * - 18 世界像素间距；点直径 1 屏幕像素（半径 0.5）。React Flow 的 `size` 是
 *   世界坐标直径，按 1/zoom 反算，缩放时点保持屏幕尺寸。
 * - 即梦在点阵间距不足 8 屏幕像素（18 × zoom < 8，约 zoom < 44.4%）时停止
 *   绘制；这里用同一门槛整层卸载，低缩放画布保持纯色。
 * - 颜色来自 --canvas-dot-color（暗色白 20% / 亮色 rgb(115,115,115) 45%）。
 *   即梦暗色另有 0–9% 的逐点透明度抖动；React Flow 的 pattern 每格只有一个
 *   圆点，无法表达逐点差异，此处保留该已知差异。
 */
const DOT_GAP = 18;
const DOT_SCREEN_DIAMETER = 1;
const MIN_SCREEN_GAP = 8;

function CanvasDotGridComponent() {
  const zoom = useStore((state) => state.transform[2]);

  if (DOT_GAP * zoom < MIN_SCREEN_GAP) return null;

  return (
    <Background
      variant={BackgroundVariant.Dots}
      gap={DOT_GAP}
      size={DOT_SCREEN_DIAMETER / zoom}
      color="var(--canvas-dot-color)"
    />
  );
}

export const CanvasDotGrid = memo(CanvasDotGridComponent);
