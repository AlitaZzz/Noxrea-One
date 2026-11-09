/**
 * 画布增量合并（纯结构运算）。
 * 只做 JSON 合并，不读库、不派生摘要、不写账本；调用方负责事务、版本与引用账本。
 */
import type { CanvasDelta } from "@server/schemas/canvas";

/**
 * 将卸荷增量合并进基础画布。
 *
 * 合并语义逐项保持既有实现：
 * - 节点 / 边：先按基础集合过滤删除项（delete 优先），命中 id 用 upsert 项替换，
 *   再追加「id 不在基础集合中」的 upsert 项；upsert 中重复的新 id 各追加一次。
 * - viewport / minimapVisible / snapEnabled / agentModel 只在 delta 对应字段
 *   `!== undefined` 时覆盖（`agentModel: null` 是有效覆盖）。
 * - 其余顶层字段从 base 原样保留。
 */
export function applyCanvasDelta(
  base: Record<string, unknown>,
  delta: CanvasDelta,
): Record<string, unknown> {
  const baseNodes = Array.isArray(base.nodes) ? (base.nodes as Record<string, unknown>[]) : [];
  const baseEdges = Array.isArray(base.edges) ? (base.edges as Record<string, unknown>[]) : [];

  const deletedNodes = new Set(delta.nodes.delete);
  const deletedEdges = new Set(delta.edges.delete);
  const nodeUpserts = new Map(delta.nodes.upsert.map((node) => [node.id as string, node]));
  const edgeUpserts = new Map(delta.edges.upsert.map((edge) => [edge.id as string, edge]));
  const existingNodeIds = new Set(baseNodes.map((node) => node.id as string));
  const existingEdgeIds = new Set(baseEdges.map((edge) => edge.id as string));

  const nodes = baseNodes
    .filter((node) => !deletedNodes.has(node.id as string))
    .map((node) => nodeUpserts.get(node.id as string) ?? node)
    .concat(delta.nodes.upsert.filter((node) => !existingNodeIds.has(node.id as string)));
  const edges = baseEdges
    .filter((edge) => !deletedEdges.has(edge.id as string))
    .map((edge) => edgeUpserts.get(edge.id as string) ?? edge)
    .concat(delta.edges.upsert.filter((edge) => !existingEdgeIds.has(edge.id as string)));

  const next: Record<string, unknown> = { ...base, nodes, edges };
  if (delta.viewport !== undefined) next.viewport = delta.viewport;
  if (delta.minimapVisible !== undefined) next.minimapVisible = delta.minimapVisible;
  if (delta.snapEnabled !== undefined) next.snapEnabled = delta.snapEnabled;
  if (delta.agentModel !== undefined) next.agentModel = delta.agentModel;
  return next;
}
