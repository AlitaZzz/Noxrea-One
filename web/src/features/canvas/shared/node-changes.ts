import type { NodeChange } from "@xyflow/react";

import type { AnyNode } from "@/features/canvas/types";

export type CanvasStateNodeChange = Extract<
  NodeChange<AnyNode>,
  { type: "position" | "select" | "dimensions" }
>;

/**
 * 受控 React Flow 必须保留用户交互和节点测量变更。
 * 结构变更仍由画布业务动作提交，避免渲染器绕过节点关系的唯一写入口。
 */
export function selectCanvasStateChanges(
  changes: NodeChange<AnyNode>[],
): CanvasStateNodeChange[] {
  return changes.filter(
    (change): change is CanvasStateNodeChange =>
      change.type === "position" || change.type === "select" || change.type === "dimensions",
  );
}
