/**
 * 组框几何与成员判定工具：成员变化时重算组框矩形（绝对坐标系，成员不嵌套在组内），
 * 以及「包含即归属」判定（拖入归组 / 组内落点创建节点共用）。
 *
 * 成员归属的判定只此一处：isGroupMember / groupMembers 是全库唯一口径
 * （显式归属 data.groupId 指向组 id，组节点自身不可能是成员、不存在嵌套组；
 * 删除组时清空归属），各处不再手写该过滤表达式。
 *
 * 设计约定：
 * - 加入成员时组框「只扩不缩」——以当前组框矩形为底，与成员外接矩形
 *   （含 GROUP_NODE_PADDING）取并集，用户手动放大的组框不被破坏；
 * - 组变空时收缩到最小尺寸（保持左上角），避免留下巨大空壳；
 * - 尺寸取值链与 tidy-layout 一致：measured > style > 兜底。
 */
import type { AnyNode } from "@/features/canvas/types";
import { GROUP_NODE_MIN_HEIGHT, GROUP_NODE_MIN_WIDTH, GROUP_NODE_PADDING, NODE_TYPE } from "@/lib/constants";

import { measureNode } from "./tidy-layout";

/** 成员归属变化后重算组框矩形。无需变化（差异 < 0.5px）时返回 null。 */
export function computeFittedGroupRect(
  group: AnyNode,
  members: AnyNode[],
): { x: number; y: number; width: number; height: number } | null {
  const gSize = measureNode(group);
  let x = group.position.x;
  let y = group.position.y;
  let maxX = x + gSize.width;
  let maxY = y + gSize.height;

  if (members.length === 0) {
    // 空组：收缩到最小尺寸，保持左上角不动
    maxX = x + GROUP_NODE_MIN_WIDTH;
    maxY = y + GROUP_NODE_MIN_HEIGHT;
  } else {
    for (const m of members) {
      const s = measureNode(m);
      x = Math.min(x, m.position.x - GROUP_NODE_PADDING);
      y = Math.min(y, m.position.y - GROUP_NODE_PADDING);
      maxX = Math.max(maxX, m.position.x + s.width + GROUP_NODE_PADDING);
      maxY = Math.max(maxY, m.position.y + s.height + GROUP_NODE_PADDING);
    }
  }

  const width = Math.max(GROUP_NODE_MIN_WIDTH, maxX - x);
  const height = Math.max(GROUP_NODE_MIN_HEIGHT, maxY - y);

  if (
    Math.abs(x - group.position.x) < 0.5 &&
    Math.abs(y - group.position.y) < 0.5 &&
    Math.abs(width - gSize.width) < 0.5 &&
    Math.abs(height - gSize.height) < 0.5
  ) {
    return null;
  }
  return { x, y, width, height };
}

/** 点是否落在组框内（含边界；尺寸取值链与 computeFittedGroupRect 一致） */
export function groupContainsPoint(group: AnyNode, point: { x: number; y: number }): boolean {
  const size = measureNode(group);
  return (
    point.x >= group.position.x &&
    point.x <= group.position.x + size.width &&
    point.y >= group.position.y &&
    point.y <= group.position.y + size.height
  );
}

/** 是否为组的成员节点（显式归属 data.groupId 指向组 id；组节点自身不参与成员）。
 *  成员判定的唯一口径，各处不再手写该表达式 */
export function isGroupMember(node: AnyNode, groupId: string): boolean {
  return node.type !== NODE_TYPE.GROUP && node.data?.groupId === groupId;
}

/** 组的成员节点列表（isGroupMember 的集合形态） */
export function groupMembers(nodes: AnyNode[], groupId: string): AnyNode[] {
  return nodes.filter((n) => isGroupMember(n, groupId));
}

/**
 * 返回包含该点的最上层组 id（数组靠后绘制在上层，自后向前找第一个命中），
 * 未命中返回 undefined。供「包含即归属」判定共用：drag stop 拖入归组、
 * 组内落点创建节点（handleCreateConnectedNode）。
 */
export function findGroupAtPoint(
  nodes: AnyNode[],
  point: { x: number; y: number }
): string | undefined {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.type === NODE_TYPE.GROUP && groupContainsPoint(n, point)) return n.id;
  }
  return undefined;
}

/**
 * 重算指定组的组框矩形（成员归属变化后），返回更新后的节点数组；
 * 无需变化的组保持原样。供 drag stop 换组/脱离（新旧组都要处理）与
 * 组内落点创建节点（只扩不缩）共用。
 */
export function refitGroupRects(nodes: AnyNode[], groupIds: Iterable<string>): AnyNode[] {
  const ids = new Set(groupIds);
  return nodes.map((n) => {
    if (n.type !== NODE_TYPE.GROUP || !ids.has(n.id)) return n;
    const rect = computeFittedGroupRect(n, groupMembers(nodes, n.id));
    if (!rect) return n;
    return {
      ...n,
      position: { x: rect.x, y: rect.y },
      style: { ...n.style, width: rect.width, height: rect.height },
    } as AnyNode;
  });
}
