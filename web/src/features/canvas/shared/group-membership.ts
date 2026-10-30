/**
 * 组成员归属（全库唯一口径）。
 *
 * 模型约定：
 * - 父子关系唯一表达是节点顶层字段 `parentId`；组（NODE_TYPE.GROUP）恒为
 *   顶层节点，组不嵌套组，成员恒为一层嵌套，组节点自身不可能是成员。
 * - 「有了归属父」与「这个父是谁」都由 memberParentId 回答，成员判定只经
 *   isGroupMember / groupMembers；任何调用方不得自行组合 type / parentId 判断。
 * - 空组即删：组不承载内容、也没有任何连线（组不可连，批量轨道绕过边系统），
 *   成员全部离开后没有存在意义，由 pruneEmptyGroups 统一清理。
 *
 * 本模块只承载归属原语，不依赖几何：组框几何（group-bounds）与整理布局
 * （tidy-layout）都建立在这里之上。
 */
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

/** 是否为组节点（组不嵌套组，组节点恒为顶层容器） */
export function isGroupNode(node: AnyNode): boolean {
  return node.type === NODE_TYPE.GROUP;
}

/**
 * 节点的归属父 id：成员的 parentId；组节点自身与顶层节点为 undefined。
 * 成员判定的唯一原语。
 */
export function memberParentId(node: AnyNode): string | undefined {
  return isGroupNode(node) ? undefined : node.parentId;
}

/** 是否为组的成员节点（归属父指向组 id；组节点自身不参与成员） */
export function isGroupMember(node: AnyNode, groupId: string): boolean {
  return memberParentId(node) === groupId;
}

/** 组的成员节点列表（isGroupMember 的集合形态） */
export function groupMembers(nodes: AnyNode[], groupId: string): AnyNode[] {
  return nodes.filter((n) => isGroupMember(n, groupId));
}

/**
 * 空组即删：移除没有任何成员的组节点，返回过滤后的数组（无空组时原引用返回）。
 * 在成员归属减少的入口统一调用：drag stop 脱离/换组（InfiniteCanvas）、
 * 成员删除（canvas-store.removeNodes）、重新编组后旧组变空（use-group-operations）。
 * 组的诞生自带成员，无合法空组阶段。
 */
export function pruneEmptyGroups(nodes: AnyNode[]): AnyNode[] {
  const membered = new Set<string>();
  for (const n of nodes) {
    const parentId = memberParentId(n);
    if (parentId) membered.add(parentId);
  }
  const isPopulated = (n: AnyNode) => !isGroupNode(n) || membered.has(n.id);
  if (nodes.every(isPopulated)) return nodes;
  return nodes.filter(isPopulated);
}

/**
 * 节点数组顺序归一化：React Flow 的子流程模型要求父节点出现在子节点之前。
 * 成员排在组之前时 React Flow 解析不到父节点（告警后按顶层计算绝对坐标），
 * 成员会渲染在相对坐标处，之后的每次拖动都按错误的绝对坐标产生位置帧，
 * 偏移量恰好是组原点——落点因此错位并被当成顶层节点。
 *
 * 组恒为顶层且组不嵌套组，因此「组全部前置」即满足该不变量；顺序已合法时
 * 原引用返回。在 store 的整体写入边界统一调用（setNodes / addNodes /
 * restoreFromProject），覆盖拖入组、粘贴、撤销/重做与历史数据加载等全部
 * 归属变化路径。
 */
export function orderGroupsBeforeMembers(nodes: AnyNode[]): AnyNode[] {
  const indexById = new Map(nodes.map((node, index) => [node.id, index] as const));
  const ordered = nodes.every((node, index) => {
    const parentId = memberParentId(node);
    if (parentId === undefined) return true;
    const parentIndex = indexById.get(parentId);
    // 父不存在（幽灵 parentId）或父不是组（模型外数据）不构成顺序约束：
    // 判定与修复都只针对组父，修复后不会留下判定仍不通过的顺序
    return parentIndex === undefined || !isGroupNode(nodes[parentIndex]) || parentIndex < index;
  });
  if (ordered) return nodes;
  return [...nodes.filter(isGroupNode), ...nodes.filter((node) => !isGroupNode(node))];
}
