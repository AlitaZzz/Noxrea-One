"use client";

import { DEFAULT_NODE_HEIGHT,DEFAULT_NODE_WIDTH } from "@/lib/constants";
import { computeNodeSize } from "@/lib/image-utils";
import { createImageNode, createVideoNode } from "@/lib/node-defaults";
import type { AssetItem } from "@/lib/types";
import { findFreePosition, useCanvasStore } from "@/stores/canvas-store";

/**
 * 将资产添加到画布视口中心。
 * 以 AssetsModal 原有逻辑为准，统一处理图片/视频节点创建、尺寸计算与字段填充，
 * 供 CanvasSidebar 与 AssetsModal 复用，避免两处行为不一致。
 */
export function addAssetToCanvas(asset: AssetItem) {
  const s = useCanvasStore.getState();
  const nw = asset.width || DEFAULT_NODE_WIDTH;
  const nh = asset.height || DEFAULT_NODE_HEIGHT;
  const { width: dw, height: dh } = computeNodeSize(nw, nh);

  const pos = findFreePosition({ width: dw, height: dh });

  // 检查资产是否带源 URL（视频 → VideoNode，图片 → ImageNode）
  const sourceUrl = asset.metadata?.sourceUrl as string | undefined;
  const isVideo =
    sourceUrl &&
    (sourceUrl.endsWith(".mp4") ||
      sourceUrl.endsWith(".webm") ||
      sourceUrl.endsWith(".mov"));

  const addNodes = s.addNodes;
  if (isVideo) {
    const node = createVideoNode(pos, sourceUrl);
    node.data.label = asset.name;
    node.data.alt = asset.name;
    node.data.naturalWidth = nw || 320;
    node.data.naturalHeight = nh || 180;
    node.style = {
      width: dw || DEFAULT_NODE_WIDTH,
      height: dh || DEFAULT_NODE_HEIGHT,
    };
    addNodes([node]);
  } else {
    const imgSrc = asset.metadata?.sourceUrl as string;
    const node = createImageNode(pos, imgSrc);
    node.data.label = asset.name;
    node.data.alt = asset.name;
    node.data.naturalWidth = nw;
    node.data.naturalHeight = nh;
    node.style = { width: dw, height: dh };
    addNodes([node]);
  }
}
