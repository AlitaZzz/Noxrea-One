"use client";

import { apiUpload } from "@/lib/api";
import { createImageNode, createEdge } from "@/lib/node-defaults";
import { useCanvasStore } from "@/stores/canvas-store";
import { THUMBNAIL_MAX } from "@/lib/constants";
import type { AnyNode } from "@/lib/types";

/**
 * 上传裁切/变换后的图片 Blob → 创建新节点 → 建连线 → 批量添加。
 *
 * 统一被 宫格切分、自由裁剪、居中裁剪（旧） 调用。
 *
 * @param sourceId  原图节点 ID
 * @param blob      裁切/变换后的图片 Blob
 * @param labelSuffix  节点 label 后缀，如 "(cropped)" / "(2-1)"
 * @param extraNodeData  可选，额外写入 node.data 的字段
 * @returns 新创建的节点，或 null（失败时）
 */
export async function uploadAndAddNode(
  sourceId: string,
  blob: Blob,
  labelSuffix: string,
  extraNodeData?: Record<string, unknown>,
): Promise<AnyNode | null> {
  const fd = new FormData();
  fd.append("file", blob, `region_${Date.now()}.png`);
  const res = await apiUpload<{ url: string }>("/api/files/upload?category=images", fd);
  if (res.code !== 200 || !res.data?.url) return null;

  const url = res.data.url;
  const store = useCanvasStore.getState();
  const origNode = store.nodes.find((n) => n.id === sourceId);
  if (!origNode) return null;

  const nw = (extraNodeData?.naturalWidth as number) || 0;
  const nh = (extraNodeData?.naturalHeight as number) || 0;
  const shortSide = Math.min(nw, nh);
  const scale = shortSide > THUMBNAIL_MAX ? THUMBNAIL_MAX / shortSide : 1;
  const displayW = nw > 0 ? Math.round(nw * scale) : 300;
  const displayH = nh > 0 ? Math.round(nh * scale) : 300;
  const titleH = 24;

  const baseX = (origNode.position.x || 0) + ((origNode.style?.width as number) || 600) + 60;
  const baseY = origNode.position.y || 0;

  const origName = (origNode.data as any)?.alt || (origNode.data as any)?.label || "image";
  // Split extension so suffix goes before it, e.g. "A.png" → "A (cropped).png"
  const dotIdx = origName.lastIndexOf(".");
  const base = dotIdx > 0 ? origName.slice(0, dotIdx) : origName;
  const ext = dotIdx > 0 ? origName.slice(dotIdx) : "";
  const label = `${base}${labelSuffix}${ext}`;
  const altName = `${base}${labelSuffix}${ext}`;

  const newNode = createImageNode({ x: baseX, y: baseY }, url);
  newNode.data.naturalWidth = nw;
  newNode.data.naturalHeight = nh;
  newNode.data.label = label;
  newNode.data.alt = altName;
  newNode.style = { width: displayW, height: displayH + titleH };
  if (extraNodeData) Object.assign(newNode.data, extraNodeData);

  const newEdge = createEdge(sourceId, newNode.id);
  store.addNodes([newNode]);
  store.setEdges([...store.edges, newEdge]);

  return newNode;
}
