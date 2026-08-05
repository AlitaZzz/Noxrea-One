"use client";

import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH } from "@/lib/constants";
import { computeNodeSize } from "@/lib/image-utils";
import { createAudioNode, createImageNode, createVideoNode } from "@/lib/node-defaults";
import type { AnyNode, AssetItem } from "@/lib/types";

/** 位置计算函数签名（由调用方从 store 注入） */
export type FindFreePosition = (size: { width: number; height: number }) => { x: number; y: number };

/**
 * 根据资产创建画布节点（纯函数，不直接操作 store）。
 *
 * 以 AssetsModal 原有逻辑为准，统一处理图片/视频/音频节点创建、尺寸计算与字段填充。
 * 调用方负责将返回的节点通过 store.addNodes 添加到画布。
 */
export function createAssetNode(asset: AssetItem, findFreePosition: FindFreePosition): AnyNode | null {
  const nw = asset.width || DEFAULT_NODE_WIDTH;
  const nh = asset.height || DEFAULT_NODE_HEIGHT;
  const { width: dw, height: dh } = computeNodeSize(nw, nh);
  const pos = findFreePosition({ width: dw, height: dh });

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
    node.style = { width: dw, height: dh };
    return node;
  }
}
