import { reserveNodeId } from "@/features/canvas/shared/node-id-registry";
import type { AnyNode } from "@/features/canvas/types";

/**
 * 画布节点身份边界。
 * 节点 ID 是节点、边、父子关系和 React key 的唯一关联键，任何进入 store
 * 的节点集合都必须满足：ID 非空且全局唯一。
 */

/** 运行时写入口使用：非法重复状态必须显式失败，不能静默破坏关系图。 */
export function assertUniqueNodeIds(nodes: AnyNode[]): void {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (typeof node.id !== "string" || node.id.length === 0) {
      throw new Error("Canvas node invariant violated: node id must be non-empty");
    }
    if (seen.has(node.id)) {
      throw new Error(`Canvas node invariant violated: duplicate node id \"${node.id}\"`);
    }
    seen.add(node.id);
    reserveNodeId(node.id);
  }
}
