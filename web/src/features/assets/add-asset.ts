/**
 * 资产到画布节点的转换层（防腐层）。
 * 以纯函数把 AssetItem 转成对应类型的画布节点并计算尺寸与落位，
 * 不直接操作任何 store，由调用方负责入库。
 */
"use client";

import type { AssetItem } from "@/features/assets/types";
import { createAudioNode, createImageNode, createVideoNode } from "@/features/canvas/node-defaults";
import type { AnyNode } from "@/features/canvas/types";
import { DEFAULT_NODE_CONTENT_HEIGHT, DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH } from "@/lib/constants";
import { computeNodeSize } from "@/lib/utils/image-utils";

/** 位置计算函数签名（由调用方从 store 注入；center 为锚点中心点，必填） */
export type FindFreePosition = (
  size: { width: number; height: number },
  center: { x: number; y: number },
) => { x: number; y: number };

/**
 * 根据资产创建画布节点（纯函数，不直接操作 store）。
 *
 * 以 AssetsModal 原有逻辑为准，统一处理图片/视频/音频节点创建、尺寸计算与字段填充。
 * 调用方负责将返回的节点通过 store.addNodes 添加到画布。
 */
export function createAssetNode(
  asset: AssetItem,
  center: { x: number; y: number },
  findFreePosition: FindFreePosition,
): AnyNode | null {
  const nw = asset.width || DEFAULT_NODE_WIDTH;
  const nh = asset.height || DEFAULT_NODE_CONTENT_HEIGHT;
  const { width: dw, height: dh } = computeNodeSize(nw, nh);
  const pos = findFreePosition({ width: dw, height: dh }, center);

  const sourceUrl = asset.metadata?.sourceUrl as string | undefined;
  const isAudio = asset.mediaType === "audio";
  const isVideo = asset.mediaType === "video";

  if (isAudio) {
    const node = createAudioNode(pos, sourceUrl);
    node.data.label = asset.name;
    node.data.alt = asset.name;
    return node;
  } else if (isVideo) {
    const node = createVideoNode(pos, sourceUrl);
    node.data.label = asset.name;
    node.data.alt = asset.name;
    node.data.naturalWidth = nw || 320;
    node.data.naturalHeight = nh || 180;
    node.data.source = "upload";
    node.style = {
      width: dw || DEFAULT_NODE_WIDTH,
      height: dh || DEFAULT_NODE_HEIGHT,
    };
    return node;
  } else {
    const imgSrc = asset.metadata?.sourceUrl as string;
    const node = createImageNode(pos, imgSrc);
    node.data.label = asset.name;
    node.data.alt = asset.name;
    node.data.naturalWidth = nw;
    node.data.naturalHeight = nh;
    node.data.source = "upload";
    node.style = { width: dw, height: dh };
    return node;
  }
}
