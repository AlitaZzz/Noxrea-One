/**
 * 派生节点创建：从「已有 URL」或「源节点」生成新图片节点并连线。
 *
 * 这是统一上传管道的「落库」半边（另一半是上传本身）。
 * 供管道（derived sink）与导演视图「截图发送到画布」复用。
 */
"use client";

import { createEdge, createImageNode } from "@/features/canvas/node-defaults";
import type { AnyEdge, AnyNode } from "@/features/canvas/types";
import { DEFAULT_NODE_WIDTH } from "@/lib/constants";
import { computeNodeSize } from "@/lib/utils/image-utils";

/** 派生节点相对源节点的水平基准间隙（px） */
const DERIVED_BASE_GAP_X = 60;

/** Store 依赖注入接口：由调用方注入所需操作，避免 lib 层直连 store */
export interface CanvasStoreApi {
  nodes: AnyNode[];
  edges: AnyEdge[];
  addNodes: (nodes: AnyNode[]) => void;
  setEdges: (edges: AnyEdge[]) => void;
}

/**
 * 派生节点标题：默认「原图名 + 后缀」并保留扩展名，labelOverride 优先。
 */
export function resolveDerivedLabel(
  origNode: AnyNode | undefined,
  labelSuffix: string,
  labelOverride?: string,
): string {
  if (labelOverride !== undefined) return labelOverride;
  const origData = origNode?.data as { alt?: string; label?: string } | undefined;
  const origName = origData?.alt || origData?.label || "image";
  const dotIdx = origName.lastIndexOf(".");
  const base = dotIdx > 0 ? origName.slice(0, dotIdx) : origName;
  const ext = dotIdx > 0 ? origName.slice(dotIdx) : "";
  return `${base}${labelSuffix}${ext}`;
}

/**
 * 派生节点位置：默认放在源节点右侧，positionOverride 优先。
 */
export function resolveDerivedPosition(
  origNode: AnyNode | undefined,
  positionOverride?: { x: number; y: number },
): { x: number; y: number } {
  if (positionOverride) return positionOverride;
  return {
    x: (origNode?.position.x || 0) + ((origNode?.style?.width as number) || DEFAULT_NODE_WIDTH) + DERIVED_BASE_GAP_X,
    y: origNode?.position.y || 0,
  };
}

/**
 * 从已有 URL 创建图片节点 -> 写入 store -> 连线到源节点。
 *
 * 适用于「URL 已存在、无需再上传」的场景（如导演视图把已上传的截图发送到画布）。
 * 需要走上传的场景请用 runMediaUpload 的 derived-node sink。
 *
 * @param sourceId    源节点 ID（新节点连线到它）
 * @param url         已存在的图片 URL
 * @param naturalW    图片自然宽度
 * @param naturalH    图片自然高度
 * @param labelSuffix 标题后缀
 * @param storeApi    由调用方注入的 store 操作接口
 */
export function createNodeFromUrl(
  sourceId: string,
  url: string,
  naturalW: number,
  naturalH: number,
  labelSuffix: string,
  storeApi: CanvasStoreApi,
  extraNodeData?: Record<string, unknown>,
  positionOverride?: { x: number; y: number },
  labelOverride?: string,
): AnyNode {
  const origNode = storeApi.nodes.find((n) => n.id === sourceId);
  const position = resolveDerivedPosition(origNode, positionOverride);
  const label = resolveDerivedLabel(origNode, labelSuffix, labelOverride);

  const node = createImageNode(position, url);
  node.data.label = label;
  node.data.alt = label;
  node.data.naturalWidth = naturalW;
  node.data.naturalHeight = naturalH;
  if (extraNodeData) Object.assign(node.data, extraNodeData);
  // 零尺寸保护：degenerate 输入（0 宽/高）按 300 兜底，避免节点塌缩为 0
  node.style = computeNodeSize(naturalW > 0 ? naturalW : 300, naturalH > 0 ? naturalH : 300);

  storeApi.addNodes([node]);
  storeApi.setEdges([...storeApi.edges, createEdge(sourceId, node.id)]);

  return node;
}
