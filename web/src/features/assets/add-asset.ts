/**
 * 资产到画布节点的转换层（防腐层）。
 * 以纯函数把 AssetItem 转成对应类型的画布节点并计算尺寸与落位，
 * 不直接操作任何 store，由调用方负责入库。
 */
"use client";

import type { AssetItem } from "@/features/assets/types";
import { createAudioNode, createImageNode, createVideoNode } from "@/features/canvas/node-defaults";
import type { AnyNode } from "@/features/canvas/types";
import { DEFAULT_NODE_CONTENT_HEIGHT, DEFAULT_NODE_WIDTH } from "@/lib/constants";
import { computeNodeSize } from "@/lib/utils/image-utils";

/** 位置计算函数签名（由调用方从 store 注入；center 为锚点中心点，必填） */
export type FindFreePosition = (
  size: { width: number; height: number },
  center: { x: number; y: number },
) => { x: number; y: number };

/**
 * 资产卡片拖入画布时 dataTransfer 上的自定义标记（值为 AssetItem 的 JSON）。
 * 拖拽源（资产抽屉卡片）与落点（画布 useFileDrop）共用此常量。
 */
export const ASSET_DRAG_TYPE = "application/x-asset";

/**
 * 根据资产创建画布节点（纯函数，不直接操作 store，同步返回）。
 *
 * 资产记录的宽高是入库时（上传弹窗 / 收藏节点）探测好的真实值，直接据此
 * 等比建节点——节点立即出现且比例正确，不做任何插入期探测（探测要等媒体
 * 下载，弱网下节点迟迟不出现，超时后还会回落成错误比例）。
 * 仅当记录缺宽高（历史坏数据或入库探测失败存了 0）时按默认尺寸落位并置 pendingNaturalSize，
 * 由 ImageNode 在主图加载完成时按图片真实宽高校正——图片本来就在加载，
 * 无需额外请求；源头（收藏/上传）已堵住，坏记录只会越来越少。
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

  const sourceUrl = asset.sourceUrl;
  const isAudio = asset.mediaType === "audio";
  const isVideo = asset.mediaType === "video";

  if (isAudio) {
    const node = createAudioNode(pos, sourceUrl);
    node.data.label = asset.name;
    return node;
  } else if (isVideo) {
    const node = createVideoNode(pos, sourceUrl);
    node.data.label = asset.name;
    node.data.naturalWidth = nw;
    node.data.naturalHeight = nh;
    node.data.source = "upload";
    node.style = { width: dw, height: dh };
    return node;
  } else {
    const imgSrc = asset.sourceUrl as string;
    const node = createImageNode(pos, imgSrc);
    node.data.label = asset.name;
    node.data.naturalWidth = nw;
    node.data.naturalHeight = nh;
    node.data.source = "upload";
    node.style = { width: dw, height: dh };
    if (!asset.width || !asset.height) {
      node.data.pendingNaturalSize = { width: dw, height: dh };
    }
    return node;
  }
}
