/**
 * 组框几何与成员判定工具：React Flow 官方 Sub Flow 模型（parentId + 相对坐标）下的
 * 组框自适应、归属判定与坐标换算。
 *
 * 模型约定（全库唯一口径）：
 * - 父子关系唯一表达是节点顶层字段 `parentId`；子节点 position 为组内相对坐标。
 * - 组（NODE_TYPE.GROUP）恒为顶层节点（组不嵌套组），成员恒为一层嵌套，因此
 *   成员绝对位置 = 组.position + 相对位置，换算成本低。
 * - 成员归属的判定只此一处：isGroupMember / groupMembers 是全库唯一口径
 *   （显式归属 parentId 指向存在的组，组节点自身不可能是成员、不存在嵌套组；
 *   删除组连带删除成员——容器型语义，保留内容只拆壳走「取消编组」）。
 * - 组框「探出才扩、只扩不缩」refit：以当前组框为底，仅当成员矩形探出组框时
 *   才朝该侧扩张（并外扩 GROUP_NODE_PADDING）；组内成员（含贴边）不推动组框，
 *   用户手动放大的组框不被破坏。拖拽中的自动扩框（expandParent）刻意不启用：
 *   一旦启用，成员拖到组边缘时组框实时扩大、成员中心永远落在扩大的组内，
 *   「拖出组」交互即失效；扩框只在归属变化的业务 refit 时发生。
 * - 空组即删（pruneEmptyGroups，成员归属减少的入口统一调用）。
 * - 尺寸取值链与 tidy-layout 一致：measured > style > 兜底。
 */
import type { AnyNode } from "@/features/canvas/types";
import { GROUP_NODE_MIN_HEIGHT, GROUP_NODE_MIN_WIDTH, GROUP_NODE_PADDING, NODE_TYPE, RAIL_WIDTH } from "@/lib/constants";

import { measureNode } from "./tidy-layout";

// ============================================================
// 坐标换算（成员相对坐标 ↔ 绝对坐标）
// 绝对（世界）坐标是对外几何语义（命中测试/落位/序列化/吸附）；成员 position
// 是组内相对坐标。换算只在本模块发生，消费者一律经此入口。
// ============================================================

/** 构建 id → 节点索引（一次构建，多处换算） */
export function buildNodeIndex(nodes: AnyNode[]): Map<string, AnyNode> {
  return new Map(nodes.map((n) => [n.id, n] as const));
}

/**
 * 节点的绝对（世界）位置：成员 = 组.position + 相对位置；顶层节点 = position。
 * nodeById 由 buildNodeIndex 构建；父不存在（脏数据）时按顶层处理（尽力而为）。
 */
export function nodeAbsolutePosition(
  node: AnyNode,
  nodeById: Map<string, AnyNode>,
): { x: number; y: number } {
  const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
  if (!parent) return node.position;
  return {
    x: parent.position.x + node.position.x,
    y: parent.position.y + node.position.y,
  };
}

/** 单节点的绝对坐标视图（toAbsoluteNodes 的单节点形态） */
export function absoluteNodeOf(node: AnyNode, nodes: AnyNode[]): AnyNode {
  const abs = nodeAbsolutePosition(node, buildNodeIndex(nodes));
  return abs === node.position ? node : { ...node, position: abs };
}

/**
 * 把节点列表映射为「绝对坐标视图」：成员换算为绝对坐标，顶层节点无变化时保持原引用。
 * 供 lib 层纯几何函数（nodeRectOf / findDerivedSlot 等）的调用方统一换算——
 * lib 层不感知分组模型，坐标换算统一发生在 feature 层调用边界。
 */
export function toAbsoluteNodes(nodes: AnyNode[]): AnyNode[] {
  const nodeById = buildNodeIndex(nodes);
  return nodes.map((n) => {
    const abs = nodeAbsolutePosition(n, nodeById);
    return abs === n.position ? n : { ...n, position: abs };
  });
}

// ============================================================
// 成员判定（唯一口径）
// ============================================================

/** 是否为组的成员节点（顶层字段 parentId 指向组 id；组节点自身不参与成员） */
export function isGroupMember(node: AnyNode, groupId: string): boolean {
  return node.type !== NODE_TYPE.GROUP && node.parentId === groupId;
}

/** 组的成员节点列表（isGroupMember 的集合形态） */
export function groupMembers(nodes: AnyNode[], groupId: string): AnyNode[] {
  return nodes.filter((n) => isGroupMember(n, groupId));
}

/**
 * 空组即删：移除没有任何成员的组节点，返回过滤后的数组（无空组时原引用返回）。
 * 组不承载内容、也没有任何连线（组不可连，批量轨道绕过边系统），成员全部
 * 离开后没有存在意义。在成员归属减少的入口统一调用：drag stop 脱离/换组
 * （InfiniteCanvas）、成员删除（canvas-store.removeNodes）、重新编组后旧组变空
 * （use-group-operations）。组的诞生自带成员，无合法空组阶段。
 */
export function pruneEmptyGroups(nodes: AnyNode[]): AnyNode[] {
  const membered = new Set<string>();
  for (const n of nodes) {
    if (n.type !== NODE_TYPE.GROUP && n.parentId) membered.add(n.parentId);
  }
  if (nodes.every((n) => n.type !== NODE_TYPE.GROUP || membered.has(n.id))) return nodes;
  return nodes.filter((n) => n.type !== NODE_TYPE.GROUP || membered.has(n.id));
}

// ============================================================
// 组框几何（refit 在组内相对空间计算；组框矩形本身是绝对坐标）
// ============================================================

/**
 * 成员归属变化后重算组框矩形（相对空间），无需变化时返回 null。
 * 规则「探出才扩、只扩不缩」：以组自身矩形为底，仅当成员矩形真正探出组框时
 * 才朝该侧扩张（并外扩 GROUP_NODE_PADDING）；完全在框内的成员（含贴边）不
 * 推动组框。若按「成员矩形无条件外扩 40px 再取并集」，组内贴边摆放（距边
 * 不足 40px）的成员会让下一次任意归属变化把组框朝它挪几像素——成员本身
 * 并未出框，属 refit 的无谓移动（历史缺陷，已修）。
 * 前置条件：组必有成员（空组即删，见 pruneEmptyGroups）。
 */
export function computeFittedGroupRect(
  group: AnyNode,
  members: AnyNode[],
): { x: number; y: number; width: number; height: number } | null {
  const gSize = measureNode(group);
  // 相对空间：以组自身矩形为底
  let relX = 0;
  let relY = 0;
  let relMaxX = gSize.width;
  let relMaxY = gSize.height;

  for (const m of members) {
    const s = measureNode(m);
    if (m.position.x < 0) {
      relX = Math.min(relX, m.position.x - GROUP_NODE_PADDING);
    }
    if (m.position.y < 0) {
      relY = Math.min(relY, m.position.y - GROUP_NODE_PADDING);
    }
    if (m.position.x + s.width > gSize.width) {
      relMaxX = Math.max(relMaxX, m.position.x + s.width + GROUP_NODE_PADDING);
    }
    if (m.position.y + s.height > gSize.height) {
      relMaxY = Math.max(relMaxY, m.position.y + s.height + GROUP_NODE_PADDING);
    }
  }

  const width = Math.max(GROUP_NODE_MIN_WIDTH, relMaxX - relX);
  const height = Math.max(GROUP_NODE_MIN_HEIGHT, relMaxY - relY);
  if (
    Math.abs(relX - 0) < 0.5 &&
    Math.abs(relY - 0) < 0.5 &&
    Math.abs(width - gSize.width) < 0.5 &&
    Math.abs(height - gSize.height) < 0.5
  ) {
    return null;
  }
  // 组框矩形是绝对坐标：相对 bbox + 组原点
  return {
    x: group.position.x + relX,
    y: group.position.y + relY,
    width,
    height,
  };
}

/**
 * 组框原点位移补偿（组几何的唯一原语）：组框是视觉容器，原点移动（向上/向左
 * 扩张、top/left 缩放）时成员相对位置反向平移，保证所有成员的视觉（绝对）
 * 位置不变。dx/dy 为组框原点位移量（新原点 − 旧原点）。无位移时原引用返回。
 * 消费方：refitGroupRects（归属变化重算组框）与 ResizeHandle（组 top/left 缩放）。
 */
export function shiftGroupMembers(
  nodes: AnyNode[],
  groupId: string,
  dx: number,
  dy: number,
): AnyNode[] {
  if (dx === 0 && dy === 0) return nodes;
  return nodes.map((n) =>
    isGroupMember(n, groupId)
      ? ({ ...n, position: { x: n.position.x - dx, y: n.position.y - dy } } as AnyNode)
      : n,
  );
}

/**
 * 重算指定组的组框矩形（成员归属变化后），返回更新后的节点数组；
 * 无需变化的组保持原样。供 drag stop 换组/脱离（新旧组都要处理）与
 * 组内落点创建节点（探出才扩）共用。
 * 组框原点发生位移（向上/向左扩张）时，成员经 shiftGroupMembers 反向补偿，
 * 成员视觉位置不变——框动内容不动。
 */
export function refitGroupRects(nodes: AnyNode[], groupIds: Iterable<string>): AnyNode[] {
  const ids = new Set(groupIds);
  if (ids.size === 0) return nodes;
  // 第一遍：计算各目标组的新矩形与原点位移（成员相对坐标在补偿前读取）
  const updates = new Map<string, { rect: { x: number; y: number; width: number; height: number }; dx: number; dy: number }>();
  for (const n of nodes) {
    if (n.type !== NODE_TYPE.GROUP || !ids.has(n.id)) continue;
    const rect = computeFittedGroupRect(n, groupMembers(nodes, n.id));
    if (!rect) continue;
    updates.set(n.id, { rect, dx: rect.x - n.position.x, dy: rect.y - n.position.y });
  }
  if (updates.size === 0) return nodes;
  // 第二遍：组更新 position/size，成员按各自组的原点位移补偿（多组同刷时
  // 成员集互斥，顺序补偿可叠加）
  let out: AnyNode[] = nodes.map((n) => {
    if (n.type !== NODE_TYPE.GROUP) return n;
    const u = updates.get(n.id);
    if (!u) return n;
    return {
      ...n,
      position: { x: u.rect.x, y: u.rect.y },
      style: { ...n.style, width: u.rect.width, height: u.rect.height },
    } as AnyNode;
  });
  for (const [groupId, u] of updates) {
    out = shiftGroupMembers(out, groupId, u.dx, u.dy);
  }
  return out;
}

/** 点是否落在组框内（含边界；组框矩形是绝对坐标，尺寸取值链与 refit 一致） */
export function groupContainsPoint(group: AnyNode, point: { x: number; y: number }): boolean {
  const size = measureNode(group);
  return (
    point.x >= group.position.x &&
    point.x <= group.position.x + size.width &&
    point.y >= group.position.y &&
    point.y <= group.position.y + size.height
  );
}

/**
 * 拖拽节点落组的归属判定（拖入高亮与 drag stop 共用的唯一口径）：
 * 以节点中心点（绝对坐标）做「包含即归属」——中心仍在原组内则归属不变；
 * 离开原组 / 原组已不存在时按落点重新判定（一次拖拽完成跨组换组或脱离）。
 * node 传拖拽中的实时节点（成员的 position 是相对坐标，由本函数换算绝对值）。
 */
export function resolveDropGroupId(nodes: AnyNode[], node: AnyNode): string | undefined {
  const nodeById = buildNodeIndex(nodes);
  const abs = nodeAbsolutePosition(node, nodeById);
  const size = measureNode(node);
  const center = {
    x: abs.x + size.width / 2,
    y: abs.y + size.height / 2,
  };
  const oldParentId = node.type !== NODE_TYPE.GROUP ? node.parentId : undefined;
  const oldGroup = oldParentId ? nodeById.get(oldParentId) : undefined;
  if (oldGroup && oldGroup.type === NODE_TYPE.GROUP && groupContainsPoint(oldGroup, center)) {
    return oldParentId;
  }
  return findGroupAtPoint(nodes, center);
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
 * 成员轨道不伸出所属组边界：返回成员节点在指定侧的轨道条带宽度。
 * 组边缘即成员条带的外界——成员圆点永远在组内侧、组圆点永远在组外侧，
 * 两者命中区天然分区、互不遮挡（此前成员条带一律外伸 80px，最贴边成员的
 * 条带越过组边缘，把组圆点的命中区整个盖住，导致组轨道「点不中」）。
 * 条带宽度 = 成员边缘到组边缘的净距（组框 refit 保证成员不出框，但贴边
 * 距离可小于 GROUP_NODE_PADDING——用户可在组内自由摆放），夹到 [0, RAIL_WIDTH]。
 * 无组归属 / 组已被删（幽灵 parentId）/ 组被手动缩小到成员之外（净距 ≤ 0，
 * 无外界可守）时返回 RAIL_WIDTH 不夹取。数据一律从传入 nodes 现取。
 */
export function memberRailWidth(
  nodes: AnyNode[],
  memberId: string | null,
  side: "left" | "right",
): number {
  const member = memberId == null ? undefined : nodes.find((n) => n.id === memberId);
  if (!member || member.type === NODE_TYPE.GROUP) return RAIL_WIDTH;
  const gid = member.parentId;
  if (!gid) return RAIL_WIDTH;
  const group = nodes.find((n) => n.id === gid && n.type === NODE_TYPE.GROUP);
  if (!group) return RAIL_WIDTH;
  // 成员 position 是组内相对坐标，与组边界同基准，可直接作差
  const mSize = measureNode(member);
  const gSize = measureNode(group);
  const clearance =
    side === "right"
      ? gSize.width - (member.position.x + mSize.width)
      : member.position.x;
  if (clearance <= 0) return RAIL_WIDTH;
  return Math.min(RAIL_WIDTH, clearance);
}
