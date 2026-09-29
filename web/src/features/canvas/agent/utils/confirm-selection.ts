/**
 * 提议-确认流程的纯函数工具：目标节点收集与勾选子集改写。
 * 不触碰 store，便于单测。
 *
 * 容器型组语义（删组连带成员，见 canvas-store.removeNodes）：delete_nodes 的
 * 确认范围必须按「实际删除集合」展开——组 id 展开为组 + 全体成员，
 * 幽灵蒙层与勾选卡都按展开集呈现；回写参数时再按勾选翻译：
 * - 组被勾 → 保留组 id（成员随容器级联，成员勾选不单列）；
 * - 组未勾、成员被勾 → 成员单独删（组若因此清空自动随之移除）。
 */
import type { AgentToolCall, ConfirmDecision } from "@/features/canvas/agent/types";
import { groupMembers } from "@/features/canvas/shared/group-bounds";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

/** delete_nodes 的容器型展开：组 id → 组 + 全体成员（去重，顺序保持） */
export function expandGroupDeletionIds(nodes: AnyNode[], ids: string[]): string[] {
  const out = new Set<string>(ids);
  for (const id of ids) {
    for (const m of groupMembers(nodes, id)) out.add(m.id);
  }
  return [...out];
}

/** 确认卡目标节点 id：delete_nodes → nodeIds 容器型展开；
 *  delete_edges → 两端去重；arrange_canvas → 全部节点 */
export function collectConfirmTargetNodeIds(calls: AgentToolCall[], nodes: AnyNode[]): string[] {
  const ids = new Set<string>();
  for (const call of calls) {
    const args = call.args as { nodeIds?: unknown; edges?: unknown };
    if (call.name === "delete_nodes") {
      const listed = Array.isArray(args.nodeIds)
        ? args.nodeIds.filter((x): x is string => typeof x === "string")
        : [];
      for (const id of expandGroupDeletionIds(nodes, listed)) ids.add(id);
    } else if (call.name === "delete_edges") {
      for (const e of Array.isArray(args.edges) ? args.edges : []) {
        const rec = e as Record<string, unknown>;
        if (typeof rec.source === "string") ids.add(rec.source);
        if (typeof rec.target === "string") ids.add(rec.target);
      }
    } else if (call.name === "arrange_canvas") {
      for (const n of nodes) ids.add(n.id);
    }
  }
  return [...ids];
}

export interface ConfirmSelectionOutcome {
  /** 改写后的待执行调用（selections 未涉及的调用原样保留；子集勾空的不执行） */
  calls: AgentToolCall[];
  /** callId → 用户在卡上勾掉的子项数 */
  skipped: Record<string, number>;
  /** 用户勾空了全部子项、整体不执行的 callId */
  dropped: string[];
}

/**
 * 按用户勾选改写确认调用的参数子集（勾选集合是容器型展开集）：
 * - delete_nodes：组被勾保留组 id（成员随容器级联）；组未勾、成员被勾则成员单独删；
 *   其余字段原样保留
 * - delete_edges：按 edgeIndexes（原数组下标）过滤，避免重复对的内容歧义
 * - 无对应 selection 视为全选原样执行
 */
export function applyConfirmSelections(
  calls: AgentToolCall[],
  selections: ConfirmDecision["selections"],
  nodes: AnyNode[],
): ConfirmSelectionOutcome {
  if (!selections) return { calls, skipped: {}, dropped: [] };
  const out: AgentToolCall[] = [];
  const skipped: Record<string, number> = {};
  const dropped: string[] = [];
  for (const call of calls) {
    const sel = selections[call.id];
    if (!sel) {
      out.push(call);
      continue;
    }
    if (call.name === "delete_nodes" && sel.nodeIds && Array.isArray(call.args.nodeIds)) {
      const original = call.args.nodeIds.filter((x): x is string => typeof x === "string");
      const display = expandGroupDeletionIds(nodes, original);
      const kept = new Set(sel.nodeIds);
      // 生效参数：原清单中被勾的项直接保留（组保留即成员随容器级联）
      const effective: string[] = [];
      for (const id of original) if (kept.has(id)) effective.push(id);
      // 展开出的成员：组未勾、成员被勾才单列（组勾了成员必随组走，勾不勾都一样）
      const inArgs = new Set(effective);
      for (const id of display) {
        if (inArgs.has(id) || !kept.has(id)) continue;
        const member = nodes.find((n) => n.id === id);
        const gid = member && member.type !== NODE_TYPE.GROUP ? member.data?.groupId : undefined;
        if (gid && !kept.has(gid)) effective.push(id);
      }
      // 用户在卡上勾掉的项数（按展开集计）
      skipped[call.id] = display.filter((id) => !kept.has(id)).length;
      if (effective.length === 0) {
        dropped.push(call.id);
      } else {
        out.push({ ...call, args: { ...call.args, nodeIds: effective } });
      }
      continue;
    }
    if (call.name === "delete_edges" && sel.edgeIndexes && Array.isArray(call.args.edges)) {
      const original = call.args.edges;
      const keptEdges = original.filter((_, i) => sel.edgeIndexes!.includes(i));
      if (keptEdges.length === 0) {
        dropped.push(call.id);
      } else {
        out.push({ ...call, args: { ...call.args, edges: keptEdges } });
      }
      skipped[call.id] = original.length - keptEdges.length;
      continue;
    }
    out.push(call);
  }
  return { calls: out, skipped, dropped };
}
