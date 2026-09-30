/**
 * 框选外框（多选瞬时候选容器）几何与成员轨道钳制：
 * ≥2 个非组节点被选中时画布出现框选外框（可见矩形 = 选中节点外接矩形四边
 * 外扩 GROUP_NODE_PADDING），右缘挂批量连线轨道（BatchConnectHandle）。
 * bbox 计算与 InfiniteCanvas 外框渲染同一实现（本模块是唯一口径）。
 *
 * 几何统一在绝对坐标空间：组内成员 position 是组内相对坐标，经 nodeById
 * 换算后参与 bbox 与轨道钳制计算。
 *
 * 外框对成员轨道的钳制与组框同一条规则（见 group-bounds.memberRailWidth）：
 * 容器边缘即成员条带外界。最贴边成员与框缘的净距恒为 GROUP_NODE_PADDING，
 * 条带被夹到 [0, RAIL_WIDTH]，圆点静止位 / 跟随范围随宽度等比收缩
 * （use-rail-dot-follow）。不钳制时最贴边成员的条带越过框缘、盖住外框批量
 * 轨道的命中区（选中节点被 xyflow 提升 zIndex，高于 ViewPortal 内的批量轨道），
 * hover 外框把手会由成员条带接管指针并把 hover 链带回成员节点，成员轨道
 * 连锁亮起——与组轨道「点不中」曾是同一病灶，组已用钳制根治。
 * 非外框成员（未选中 / 单选）不受钳制。
 */
import type { AnyNode } from "@/features/canvas/types";
import { GROUP_NODE_PADDING, NODE_TYPE, RAIL_WIDTH } from "@/lib/constants";

import { buildNodeIndex, nodeAbsolutePosition } from "./group-bounds";
import { measureNode } from "./tidy-layout";

export interface SelectionFrame {
  ids: string[];
  bbox: { x: number; y: number; width: number; height: number };
}

/** 框选外框：<2 个非组选中节点时无外框（返回 null）。尺寸取值链与组框一致（measureNode） */
export function computeSelectionFrame(nodes: AnyNode[]): SelectionFrame | null {
  const sel = nodes.filter((n) => n.selected && n.type !== NODE_TYPE.GROUP);
  if (sel.length < 2) return null;
  const nodeById = buildNodeIndex(nodes);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of sel) {
    const abs = nodeAbsolutePosition(n, nodeById);
    const s = measureNode(n);
    minX = Math.min(minX, abs.x);
    minY = Math.min(minY, abs.y);
    maxX = Math.max(maxX, abs.x + s.width);
    maxY = Math.max(maxY, abs.y + s.height);
  }
  return {
    ids: sel.map((n) => n.id),
    bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
  };
}

/** 外框成员在指定侧的条带宽度：外界为可见框缘（bbox ± GROUP_NODE_PADDING）。
 *  非外框成员 / 无外框 / 净距 ≤ 0（节点贴出框缘，理论不可达）时返回 RAIL_WIDTH 不夹取 */
export function frameRailWidth(
  nodes: AnyNode[],
  memberId: string | null,
  side: "left" | "right",
): number {
  if (memberId == null) return RAIL_WIDTH;
  const frame = computeSelectionFrame(nodes);
  if (!frame || !frame.ids.includes(memberId)) return RAIL_WIDTH;
  const member = nodes.find((n) => n.id === memberId);
  if (!member) return RAIL_WIDTH;
  const nodeById = buildNodeIndex(nodes);
  const abs = nodeAbsolutePosition(member, nodeById);
  const mSize = measureNode(member);
  const clearance =
    side === "right"
      ? frame.bbox.x + frame.bbox.width + GROUP_NODE_PADDING - (abs.x + mSize.width)
      : abs.x - (frame.bbox.x - GROUP_NODE_PADDING);
  if (clearance <= 0) return RAIL_WIDTH;
  return Math.min(RAIL_WIDTH, clearance);
}
