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
 * - 空组即删（pruneEmptyGroups，成员归属减少的三处入口统一调用）——组不
 *   承载内容，成员全部离开后没有存在意义，不再保留空壳；组的诞生自带成员
 *   （选中 ≥2 节点编组），不存在合法的空组阶段；
 * - 尺寸取值链与 tidy-layout 一致：measured > style > 兜底。
 */
import type { AnyNode } from "@/features/canvas/types";
import { GROUP_NODE_MIN_HEIGHT, GROUP_NODE_MIN_WIDTH, GROUP_NODE_PADDING, NODE_TYPE, RAIL_WIDTH } from "@/lib/constants";

import { measureNode } from "./tidy-layout";

/** 成员归属变化后重算组框矩形。无需变化（差异 < 0.5px）时返回 null。
 *  前置条件：组必有成员（空组即删，见 pruneEmptyGroups），不再处理空组收缩。 */
export function computeFittedGroupRect(
  group: AnyNode,
  members: AnyNode[],
): { x: number; y: number; width: number; height: number } | null {
  const gSize = measureNode(group);
  let x = group.position.x;
  let y = group.position.y;
  let maxX = x + gSize.width;
  let maxY = y + gSize.height;

  for (const m of members) {
    const s = measureNode(m);
    x = Math.min(x, m.position.x - GROUP_NODE_PADDING);
    y = Math.min(y, m.position.y - GROUP_NODE_PADDING);
    maxX = Math.max(maxX, m.position.x + s.width + GROUP_NODE_PADDING);
    maxY = Math.max(maxY, m.position.y + s.height + GROUP_NODE_PADDING);
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
 * 空组即删：移除没有任何成员的组节点，返回过滤后的数组（无空组时原引用返回）。
 * 组不承载内容、也没有任何连线（组不可连，批量轨道绕过边系统），成员全部
 * 离开后没有存在意义。在成员归属减少的三处入口统一调用：drag stop 脱离/换组
 * （InfiniteCanvas）、成员删除（canvas-store.removeNodes）、重新编组后旧组变空
 * （use-group-operations）。组的诞生自带成员，无合法空组阶段。
 */
export function pruneEmptyGroups(nodes: AnyNode[]): AnyNode[] {
  const membered = new Set<string>();
  for (const n of nodes) {
    if (n.type !== NODE_TYPE.GROUP && n.data?.groupId) membered.add(n.data.groupId);
  }
  if (nodes.every((n) => n.type !== NODE_TYPE.GROUP || membered.has(n.id))) return nodes;
  return nodes.filter((n) => n.type !== NODE_TYPE.GROUP || membered.has(n.id));
}

/**
 * 成员轨道不伸出所属组边界：返回成员节点在指定侧的轨道条带宽度。
 * 组边缘即成员条带的外界——成员圆点永远在组内侧、组圆点永远在组外侧，
 * 两者命中区天然分区、互不遮挡（此前成员条带一律外伸 80px，最贴边成员的
 * 条带越过组边缘，把组圆点的命中区整个盖住，导致组轨道「点不中」）。
 * 组内最近成员距组边缘恒为 GROUP_NODE_PADDING（组框由成员 bbox 外扩而来），
 * 条带因此被夹到 [0, RAIL_WIDTH]。
 * 无组归属 / 组已被删（幽灵 groupId）/ 组被手动缩小到成员之外（净距 ≤ 0，
 * 无外界可守）时返回 RAIL_WIDTH 不夹取。数据一律从传入 nodes 现取。
 */
export function memberRailWidth(
  nodes: AnyNode[],
  memberId: string | null,
  side: "left" | "right",
): number {
  const member = memberId == null ? undefined : nodes.find((n) => n.id === memberId);
  if (!member || member.type === NODE_TYPE.GROUP) return RAIL_WIDTH;
  const gid = member.data?.groupId;
  if (!gid) return RAIL_WIDTH;
  const group = nodes.find((n) => n.id === gid && n.type === NODE_TYPE.GROUP);
  if (!group) return RAIL_WIDTH;
  const mSize = measureNode(member);
  const gSize = measureNode(group);
  const clearance =
    side === "right"
      ? group.position.x + gSize.width - (member.position.x + mSize.width)
      : member.position.x - group.position.x;
  if (clearance <= 0) return RAIL_WIDTH;
  return Math.min(RAIL_WIDTH, clearance);
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
