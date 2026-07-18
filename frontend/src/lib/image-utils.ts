"use client";

import { apiUpload } from "@/lib/api";
import { createImageNode, createEdge } from "@/lib/node-defaults";
import { useCanvasStore } from "@/stores/canvas-store";
import { THUMBNAIL_MAX } from "@/lib/constants";
import type { AnyNode } from "@/lib/types";

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
 * 不调 addNodes/setEdges，无副作用，可安全地在循环中调用。
 *
 * @param sourceId        原图节点 ID
 * @param url             图片 URL
 * @param naturalW        图片自然宽度
 * @param naturalH        图片自然高度
 * @param labelSuffix     节点 label 后缀，如 " (cropped)" / " (bg-removed)"
 * @param extraNodeData   额外写入 node.data 的字段
 * @param positionOverride  节点位置（不传则默认放在原图节点右侧）
 */
export function buildNodeFromUrl(
  sourceId: string,
  url: string,
  naturalW: number,
  naturalH: number,
  labelSuffix: string,
  extraNodeData?: Record<string, unknown>,
  positionOverride?: { x: number; y: number },
): AnyNode {
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

  // Display dimensions (thumbnail-scaled)
  const shortSide = Math.min(naturalW, naturalH);
  const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
  const displayW = naturalW > 0 ? Math.round(naturalW * scale) : 300;
  const displayH = naturalH > 0 ? Math.round(naturalH * scale) : 300;
  const titleH = 24;

  // Label: insert suffix before extension
  const origName = (origNode?.data as any)?.alt || (origNode?.data as any)?.label || "image";
  const dotIdx = origName.lastIndexOf(".");
  const base = dotIdx > 0 ? origName.slice(0, dotIdx) : origName;
  const ext = dotIdx > 0 ? origName.slice(dotIdx) : "";
  const label = `${base}${labelSuffix}${ext}`;

  const newNode = createImageNode({ x, y }, url);
  newNode.data.naturalWidth = naturalW;
  newNode.data.naturalHeight = naturalH;
  newNode.data.label = label;
  newNode.data.alt = label;
  newNode.style = { width: displayW, height: displayH + titleH };
  if (extraNodeData) Object.assign(newNode.data, extraNodeData);

  return newNode;
}

/**
 * 从已有 URL 创建衍生节点 + 连线（单节点场景）。
 * 适合结果是图片 URL 的场景（如抠图任务完成、外部图片）。
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
  const newNode = buildNodeFromUrl(sourceId, url, naturalW, naturalH, labelSuffix, extraNodeData, positionOverride);
  if (!newNode) return null;

  const store = useCanvasStore.getState();
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
