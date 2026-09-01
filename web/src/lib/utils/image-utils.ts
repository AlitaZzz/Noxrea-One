/**
 * 图像与媒体处理工具集（纯计算与本地加工，不含上传与 store 操作）。
 * 提供显示尺寸换算、媒体自然尺寸读取、Canvas 导出，
 * 以及派生节点的网格布局计算。
 *
 * 上传与落库统一走 features/canvas/upload 的上传管道，本模块不再涉及。
 */
"use client";

import type { ImageNode } from "@/features/canvas/types";
import { NODE_DISPLAY_MAX, NODE_TITLE_HEIGHT } from "@/lib/constants";

/**
 * 纯函数：计算 NODE_DISPLAY_MAX 等比缩放后的显示尺寸（长边约束）。
 *
 * 返回 { scale, displayW, displayH }，不含标题栏高度（titleH 由调用方酌情添加）。
 *
 * @param naturalW  图片自然宽度
 * @param naturalH  图片自然高度
 * @param max       可选，长边最大像素值，默认 NODE_DISPLAY_MAX(600)
 */
export function computeThumbScale(
  naturalW: number,
  naturalH: number,
  max?: number,
): { scale: number; displayW: number; displayH: number } {
  const limit = max ?? NODE_DISPLAY_MAX;
  const longSide = Math.max(naturalW, naturalH);
  const scale = longSide > limit ? limit / longSide : 1;
  return {
    scale,
    displayW: Math.round(naturalW * scale),
    displayH: Math.round(naturalH * scale),
  };
}

/**
 * 计算节点的显示尺寸（等比缩放 + 标题栏高度）。
 *
 * 所有创建/更新图片/视频节点的路径应统一使用此函数，
 * 避免遗漏 titleH 导致的图片区域压缩。
 */
export function computeNodeSize(naturalW: number, naturalH: number): { width: number; height: number } {
  const { displayW, displayH } = computeThumbScale(naturalW, naturalH);
  return { width: displayW, height: displayH + NODE_TITLE_HEIGHT };
}

/**
 * 对节点应用 NODE_DISPLAY_MAX 等比缩放，并预留 titleH(28px) 标题栏高度。
 *
 * @param node        已创建的 ImageNode（通常通过 createImageNode）
 * @param naturalW    图片自然宽度
 * @param naturalH    图片自然高度
 * @param label       可选，设置 label 和 alt
 * @returns 被修改后的 node（方便链式调用）
 */
export function applyThumbnailSettings(
  node: ImageNode,
  naturalW: number,
  naturalH: number,
  label?: string,
): ImageNode {
  // 零尺寸保护：fallback 300
  const nw = naturalW > 0 ? naturalW : 300;
  const nh = naturalH > 0 ? naturalH : 300;
  const { width, height } = computeNodeSize(nw, nh);

  node.data.naturalWidth = naturalW;
  node.data.naturalHeight = naturalH;
  if (label !== undefined) {
    node.data.label = label;
    node.data.alt = label;
  }
  node.style = { width, height };
  return node;
}

/**
 * 创建 Canvas -> 执行绘制 -> 导出 Blob。
 *
 * 提取的是 createElement("canvas") + getContext("2d") + toBlob 的公共管线，
 * 具体的绘制逻辑由 draw 回调处理，不强求统一。
 *
 * @param width   canvas 宽度
 * @param height  canvas 高度
 * @param draw    绘制回调，接收 (ctx, canvas)
 * @param type    导出 MIME 类型，默认 "image/png"
 * @param quality 导出质量（0-1），仅对 image/jpeg 生效
 */
export function canvasToBlob(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void,
  type?: string,
  quality?: number,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  draw(ctx, canvas);
  return new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), type || "image/png", quality));
}

/**
 * 异步加载图片/视频的真实显示尺寸。
 *
 * 适用于需要在节点创建前获取媒体原始宽高的场景。
 *
 * @param url      媒体 URL
 * @param isVideo  是否为视频（影响加载方式）
 * @returns { w, h } 宽高，失败时返回 0
 */
export function loadMediaDimensions(url: string, isVideo: boolean): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    if (isVideo) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve({ w: v.videoWidth || 1152, h: v.videoHeight || 768 });
      v.onerror = () => resolve({ w: 0, h: 0 });
      v.src = url;
    } else {
      const img = new window.Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = url;
    }
  });
}

// ── 派生节点网格布局 ──
// 宫格切分、全景多视角截图等批量派生节点统一使用此布局，
// 保证各处"源节点右侧网格"的基准点与步进逻辑一致。

/** 派生节点相对源节点的水平基准间隙（px） */
const DERIVED_BASE_GAP_X = 60;
/** 相邻派生节点之间的间隙（px） */
const DERIVED_CELL_GAP = 12;

export interface DerivedGridLayout {
  baseX: number;
  baseY: number;
  stepX: number;
  stepY: number;
  cols: number;
  displayW: number;
  displayH: number;
}

/**
 * 计算派生节点网格布局。
 *
 * 基准点 = 源节点右侧 + 60px；水平步进 = 单格显示宽度 + 间隙；
 * 垂直步进 = 单格显示高度 + 标题栏(NODE_TITLE_HEIGHT) + 间隙，避免下一行压住 title。
 * 宫格切分、全景多视角截图等批量派生节点统一通过此函数计算位置，
 * 保证在画布上排列紧凑整齐且各处逻辑一致。
 *
 * @param sourceNode    源节点（用于定位网格基准点，可为空）
 * @param cellNaturalW  单个派生节点的自然宽度
 * @param cellNaturalH  单个派生节点的自然高度
 * @param cols          网格每行放置的节点数
 */
export function computeDerivedGrid(
  sourceNode: { position: { x: number; y: number }; style?: { width?: number | string } } | undefined,
  cellNaturalW: number,
  cellNaturalH: number,
  cols: number,
): DerivedGridLayout {
  const { displayW, displayH } = computeThumbScale(cellNaturalW, cellNaturalH);
  return {
    baseX: (sourceNode?.position.x || 0) + ((sourceNode?.style?.width as number) || 600) + DERIVED_BASE_GAP_X,
    baseY: sourceNode?.position.y || 0,
    stepX: displayW + DERIVED_CELL_GAP,
    // 纵向需计入标题栏高度，避免下一行节点压住上一行的 title
    stepY: displayH + NODE_TITLE_HEIGHT + DERIVED_CELL_GAP,
    cols,
    displayW,
    displayH,
  };
}

/**
 * 根据网格布局与索引计算节点位置（行优先，从左到右）。
 *
 * @param layout computeDerivedGrid 的返回值
 * @param index  节点在批量创建顺序中的索引（0 起）
 */
export function gridPositionAt(layout: DerivedGridLayout, index: number): { x: number; y: number } {
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  return { x: layout.baseX + col * layout.stepX, y: layout.baseY + row * layout.stepY };
}
