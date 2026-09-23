/**
 * 提议-确认流程的纯函数工具：目标节点收集与勾选子集改写。
 * 不触碰 store，便于单测。
 */
import type { AgentToolCall, ConfirmDecision } from "@/features/canvas/agent/types";

/** 确认卡目标节点 id：delete_nodes → nodeIds；delete_edges → 两端去重；arrange_canvas → 全部节点 */
export function collectConfirmTargetNodeIds(calls: AgentToolCall[], allNodeIds: string[]): string[] {
  const ids = new Set<string>();
  for (const call of calls) {
    const args = call.args as { nodeIds?: unknown; edges?: unknown };
    if (call.name === "delete_nodes") {
      for (const id of Array.isArray(args.nodeIds) ? args.nodeIds : []) if (typeof id === "string") ids.add(id);
    } else if (call.name === "delete_edges") {
      for (const e of Array.isArray(args.edges) ? args.edges : []) {
        const rec = e as Record<string, unknown>;
        if (typeof rec.source === "string") ids.add(rec.source);
        if (typeof rec.target === "string") ids.add(rec.target);
      }
    } else if (call.name === "arrange_canvas") {
      for (const id of allNodeIds) ids.add(id);
    }
  }
  return [...ids];
}

export interface ConfirmSelectionOutcome {
  /** 改写后的待执行调用（selections 未涉及的调用原样保留；子集勾空的不执行） */
  calls: AgentToolCall[];
  /** callId → 被用户勾掉的子项数 */
  skipped: Record<string, number>;
  /** 用户勾空了全部子项、整体不执行的 callId */
  dropped: string[];
}

/**
 * 按用户勾选改写确认调用的参数子集：
 * - delete_nodes：nodeIds 替换为勾选保留项
 * - delete_edges：按 edgeIndexes（原数组下标）过滤，避免重复对的内容歧义
 * - 无对应 selection 视为全选原样执行
 */
export function applyConfirmSelections(
  calls: AgentToolCall[],
  selections?: ConfirmDecision["selections"]
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
      const kept = original.filter((id) => sel.nodeIds!.includes(id));
      if (kept.length === 0) {
        dropped.push(call.id);
      } else {
        out.push({ ...call, args: { ...call.args, nodeIds: kept } });
      }
      skipped[call.id] = original.length - kept.length;
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
