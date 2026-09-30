/**
 * 画布坐标点的节点命中测试：返回包含该点的最上层节点。
 *
 * 供拖拽连线的实时反馈（ConnectionFlowLine / use-batch-connect-drag 的倾斜/毛玻璃）
 * 与松手落点判定（InfiniteCanvas.handleConnectEnd）共用同一口径，确保
 * 「拖拽中看到的反馈」与「松手后的实际结果」一致。
 *
 * 组内成员 position 是组内相对坐标：几何判定统一在绝对坐标空间进行，
 * 由 nodeById（buildNodeIndex 构建）换算。数组靠后的节点绘制在上层，
 * 自后向前找第一个命中；尺寸优先取 style 声明值、缺失时兜底 xyflow 实测
 * 尺寸（measured），两者皆无（未渲染）的节点不参与命中。
 */
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

import { buildNodeIndex, nodeAbsolutePosition } from "./group-bounds";

/** 命中盒坐标 */
export interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 节点的命中盒（绝对坐标）：优先 style 声明值，缺失时兜底 xyflow 实测尺寸（measured）。
 * 上传/粘贴创建的媒体节点在媒体加载完成前 style 为 null，若无兜底会在加载窗口期
 * 对命中测试不可见（悬停无反馈、松手误判空白弹菜单）。
 */
export function getNodeBox(
  n: AnyNode,
  nodeById: Map<string, AnyNode>,
): NodeBox | null {
  const width =
    typeof n.style?.width === "number" ? n.style.width : (n.measured?.width ?? 0);
  const height =
    typeof n.style?.height === "number" ? n.style.height : (n.measured?.height ?? 0);
  if (width <= 0 || height <= 0) return null;
  const abs = nodeAbsolutePosition(n, nodeById);
  return { x: abs.x, y: abs.y, width, height };
}

/**
 * 节点连线锚点：指定侧边缘垂直正中（绝对坐标；与已建立连线的锚点口径一致，
 * 见 constants.ts 的 insetHandleCenter 说明）。无有效盒尺寸（未渲染）返回 null。
 */
export function nodeEdgeAnchor(
  n: AnyNode,
  side: "left" | "right",
  nodeById: Map<string, AnyNode>,
): { x: number; y: number } | null {
  const box = getNodeBox(n, nodeById);
  if (!box) return null;
  return {
    x: side === "left" ? box.x : box.x + box.width,
    y: box.y + box.height / 2,
  };
}

/**
 * 返回包含 flow 坐标点 point 的最上层节点，未命中返回 null。
 *
 * 组节点（NODE_TYPE.GROUP）不参与命中——组是空间容器而非可连接实体（行业内
 * 节点画布的通行口径），其空白区域对连线表现为画布空白（松手弹创建菜单、
 * 悬停无反馈），组内子节点则正常命中（子节点渲染在组之上，跳过组也保证了
 * 悬停组内子节点时不会错误地命中最上层的组）。发起端节点命中（自连）由调用方
 * 处理，与实时反馈保持一致。
 */
export function findNodeAtFlowPoint(
  nodes: AnyNode[],
  point: { x: number; y: number }
): AnyNode | null {
  const nodeById = buildNodeIndex(nodes);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.type === NODE_TYPE.GROUP) continue;
    const box = getNodeBox(n, nodeById);
    if (!box) continue;
    if (
      point.x < box.x || point.x > box.x + box.width ||
      point.y < box.y || point.y > box.y + box.height
    ) continue;
    return n;
  }
  return null;
}
