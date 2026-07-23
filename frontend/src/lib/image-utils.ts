"use client";

import { apiUpload } from "@/lib/api";
import { createImageNode, createEdge } from "@/lib/node-defaults";
import { useCanvasStore } from "@/stores/canvas-store";
import { NODE_DISPLAY_MAX } from "@/lib/constants";
import type { AnyNode, ImageNode } from "@/lib/types";

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

/** 节点头部标题栏高度（px） */
const TITLE_H = 24;

/**
 * 计算节点的显示尺寸（等比缩放 + 标题栏高度）。
 *
 * 所有创建/更新图片/视频节点的路径应统一使用此函数，
 * 避免遗漏 titleH 导致的图片区域压缩。
 */
export function computeNodeSize(naturalW: number, naturalH: number): { width: number; height: number } {
  const { displayW, displayH } = computeThumbScale(naturalW, naturalH);
  return { width: displayW, height: displayH + TITLE_H };
}

/**
 * 对节点应用 NODE_DISPLAY_MAX 等比缩放，并预留 titleH(24px) 标题栏高度。
 *
 * 所有创建图片节点的路径都应通过此函数统一计算显示尺寸，
 * 避免遗漏 titleH 导致的图片区域压缩。
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
 * 创建 Canvas → 执行绘制 → 导出 Blob。
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

/**
 * 上传图片 Blob → 返回 URL。
 * 纯上传，无节点操作，可安全地在循环中调用。
 */
export async function uploadBlob(blob: Blob, filename?: string): Promise<string | null> {
  const fd = new FormData();
  fd.append("file", blob, filename || `region_${Date.now()}.png`);
  const res = await apiUpload<{ url: string }>("/api/files/upload?category=images", fd);
  if (res.code !== 200 || !res.data?.url) return null;
  return res.data.url;
}

/**
 * 纯函数：计算衍生节点的位置、尺寸、data，返回节点对象。
 *
/**
 * 从已有 URL 创建 ImageNode → 写入 store → 连线到源节点。
 * 适合：抠图任务完成、宫格切分、截图发送到画布等。
 */
export async function createNodeFromUrl(
  sourceId: string,
  url: string,
  naturalW: number,
  naturalH: number,
  labelSuffix: string,
  extraNodeData?: Record<string, unknown>,
  positionOverride?: { x: number; y: number },
): Promise<AnyNode | null> {
  const store = useCanvasStore.getState();
  const origNode = store.nodes.find((n) => n.id === sourceId);

  // Position
  let x: number;
  let y: number;
  if (positionOverride) {
    x = positionOverride.x;
    y = positionOverride.y;
  } else {
    x = (origNode?.position.x || 0) + ((origNode?.style?.width as number) || 600) + 60;
    y = origNode?.position.y || 0;
  }

  // Label: insert suffix before extension
  const origData = origNode?.data as { alt?: string; label?: string } | undefined;
  const origName = origData?.alt || origData?.label || "image";
  const dotIdx = origName.lastIndexOf(".");
  const base = dotIdx > 0 ? origName.slice(0, dotIdx) : origName;
  const ext = dotIdx > 0 ? origName.slice(dotIdx) : "";
  const label = `${base}${labelSuffix}${ext}`;

  const newNode = createImageNode({ x, y }, url);
  applyThumbnailSettings(newNode, naturalW, naturalH, label);
  if (extraNodeData) Object.assign(newNode.data, extraNodeData);

  store.addNodes([newNode]);
  const newEdge = createEdge(sourceId, newNode.id);
  store.setEdges([...store.edges, newEdge]);

  return newNode;
}

/**
 * 上传裁切/变换后的图片 Blob → 创建新节点 → 建连线 → 批量添加。
 *
 * uploadBlob + createNodeFromUrl 的便捷包装。
 *
 * @param sourceId        原图节点 ID
 * @param blob            处理后的图片 Blob
 * @param labelSuffix     节点 label 后缀，如 " (cropped)" / "(2-1)"
 * @param extraNodeData   可选，额外写入 node.data 的字段
 * @param positionOverride  节点位置（不传则默认放在原图节点右侧）
 * @returns 新创建的节点，或 null（失败时）
 */
export async function uploadAndAddNode(
  sourceId: string,
  blob: Blob,
  labelSuffix: string,
  extraNodeData?: Record<string, unknown>,
  positionOverride?: { x: number; y: number },
): Promise<AnyNode | null> {
  const url = await uploadBlob(blob);
  if (!url) return null;

  const nw = (extraNodeData?.naturalWidth as number) || 0;
  const nh = (extraNodeData?.naturalHeight as number) || 0;

  return createNodeFromUrl(sourceId, url, nw, nh, labelSuffix, extraNodeData, positionOverride);
}
