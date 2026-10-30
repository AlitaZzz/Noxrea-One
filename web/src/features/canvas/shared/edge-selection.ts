/**
 * 边与选中的关系判定。
 *
 * 框选提交（写入边选中）与高亮派生（统计高亮边）必须使用同一端点规则：
 * 任一端点被选中即视为该边与选中相关。`selectable` 等写入条件由调用方补充。
 */
import type { Edge } from "@xyflow/react";

export function edgeTouchesSelection(
  edge: Pick<Edge, "source" | "target">,
  selectedIds: ReadonlySet<string>,
): boolean {
  return selectedIds.has(edge.source) || selectedIds.has(edge.target);
}
