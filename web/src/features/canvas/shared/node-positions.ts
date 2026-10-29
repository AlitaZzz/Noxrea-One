/**
 * 位置帧应用口径（拖动终态提交与程序化位置帧共用）。
 *
 * 受控 store 的位置写入有两条路径：拖动预览会话的终态提交（规则 1.8），以及
 * 没有拖动会话时程序化位置帧的直接写入（规则 6.4）。两条路径共用本模块的
 * 帧/Map 转换与按 id 写入：未涉及或位置未变的节点保持原引用。规则见
 * specs/canvas-drag-preview-session.md。
 */
import type { AnyNode } from "@/features/canvas/types";

/** 位置帧：位置变更进入受控 store 的统一形状（拖动预览与直接写入共用） */
export interface PositionFrame {
  id: string;
  position: { x: number; y: number };
}

/** 帧列表 → 按 id 的位置表（会话预览/提交的落库口径） */
export function toPositionMap(
  frames: readonly PositionFrame[],
): Map<string, { x: number; y: number }> {
  return new Map(frames.map((frame) => [frame.id, frame.position] as const));
}

/** 按 id 的位置表 → 帧列表（兜底提交把会话内保存的帧重新送入公共入口） */
export function toPositionFrames(
  positions: ReadonlyMap<string, { x: number; y: number }>,
): PositionFrame[] {
  return [...positions].map(([id, position]) => ({ id, position }));
}

/**
 * 按 id 写入节点位置。
 * `changed=false` 表示没有任何节点位置变化，此时返回原数组引用（不产生写入）。
 */
export function applyNodePositions(
  nodes: AnyNode[],
  positions: ReadonlyMap<string, { x: number; y: number }>,
): { nodes: AnyNode[]; changed: boolean } {
  let changed = false;
  const next = nodes.map((node) => {
    const position = positions.get(node.id);
    if (!position) return node;
    if (node.position.x === position.x && node.position.y === position.y) return node;
    changed = true;
    return { ...node, position };
  });
  return changed ? { nodes: next, changed } : { nodes, changed: false };
}
