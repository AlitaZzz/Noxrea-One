import { reserveNodeId } from "@/features/canvas/shared/node-id-registry";
import type { AnyNode } from "@/features/canvas/types";

/**
 * 画布节点身份边界。
 * 节点 ID 是节点、边、父子关系和 React key 的唯一关联键，任何进入 store
 * 的节点集合都必须满足：ID 非空且全局唯一。
 */

/** 模块级复用缓冲：每次调用前清空，避免每帧写入都分配 Set（同步调用，无重入）。 */
const seenIds = new Set<string>();

/** 运行时写入口使用：非法重复状态必须显式失败，不能静默破坏关系图。 */
export function assertUniqueNodeIds(nodes: AnyNode[]): void {
  seenIds.clear();
  try {
    for (const node of nodes) {
      if (typeof node.id !== "string" || node.id.length === 0) {
        throw new Error("Canvas node invariant violated: node id must be non-empty");
      }
      if (seenIds.has(node.id)) {
        throw new Error(`Canvas node invariant violated: duplicate node id "${node.id}"`);
      }
      seenIds.add(node.id);
      reserveNodeId(node.id);
    }
  } finally {
    // 失败时同样清空，下一次调用不携带残留状态
    seenIds.clear();
  }
}
