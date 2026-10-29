/**
 * 拖动吸附的纯计算（预览与提交共用）。
 *
 * 与改造前 `handleNodesChange` 的吸附分支同口径：仅「拖动项 = 1」且 `snapToGrid`
 * 开启时吸附；对齐判定在绝对坐标空间进行，成员（组内相对坐标）先换算为绝对
 * 位置，吸附结果再换回相对坐标。拖动预览会话每帧与提交各调用一次，保证所见
 * 即所得（specs/canvas-drag-preview-session.md 规则 3.1、3.2）。
 */
import {
  type AlignmentGuide,
  computeAlignment,
  isAlignmentCandidate,
} from "@/features/canvas/hooks/use-alignment-guides";
import { buildNodeIndex, nodeAbsolutePosition } from "@/features/canvas/shared/group-bounds";
import { memberParentId } from "@/features/canvas/shared/group-membership";
import type { AnyNode } from "@/features/canvas/types";
import { LAYOUT_GAP } from "@/lib/constants";

export interface DragSnapSettings {
  snapToGrid: boolean;
  snapGridSize: number;
  snapThreshold: number;
}

export interface DragSnapOutcome {
  /** 吸附后的相对位置（与 store 的 position 同口径） */
  position: { x: number; y: number };
  guides: AlignmentGuide[];
}

const NO_GUIDES: AlignmentGuide[] = [];

/** 节点盒尺寸：显式尺寸优先，其次实测尺寸，最后按默认盒兜底（与改造前一致） */
function nodeBoxSize(node: AnyNode): { width: number; height: number } {
  return {
    width: Number(node.style?.width) || Number(node.measured?.width) || 200,
    height: Number(node.style?.height) || Number(node.measured?.height) || 120,
  };
}

/**
 * 计算拖动项在给定原始位置下的吸附位置与辅助线。
 *
 * @param draggedId 拖动项 id
 * @param rawPosition React Flow 位置帧给出的相对位置
 * @param baseNodes 会话基准的节点快照（拖动前 store 节点）
 * @param settings 会话开始时捕获的吸附设置
 */
export function resolveDragPosition(
  draggedId: string,
  rawPosition: { x: number; y: number },
  baseNodes: AnyNode[],
  settings: DragSnapSettings,
): DragSnapOutcome {
  if (!settings.snapToGrid) return { position: rawPosition, guides: NO_GUIDES };

  const nodeById = buildNodeIndex(baseNodes);
  const base = nodeById.get(draggedId);
  if (!base) return { position: rawPosition, guides: NO_GUIDES };

  const absPositionOf = (node: AnyNode) => nodeAbsolutePosition(node, nodeById);
  // 父节点在拖拽中不动（拖成员时组未被拖拽），绝对位置 = 父位置 + 相对位置
  const frameNode = { ...base, position: rawPosition } as AnyNode;
  const absPos = absPositionOf(frameNode);
  const dragBounds = { id: draggedId, position: absPos, ...nodeBoxSize(frameNode) };

  // 空间分区：只对可能产生吸附的邻近节点构建边界，大幅降低大画布下每帧开销
  const nodeBounds = baseNodes
    .filter(
      (node) =>
        node.id !== draggedId &&
        isAlignmentCandidate(
          dragBounds,
          { id: node.id, position: absPositionOf(node), ...nodeBoxSize(node) },
          settings.snapThreshold,
          LAYOUT_GAP,
        ),
    )
    .map((node) => ({ id: node.id, position: absPositionOf(node), ...nodeBoxSize(node) }));

  const result = computeAlignment(dragBounds, nodeBounds, settings.snapThreshold, LAYOUT_GAP);

  let absX = result.snapX ?? Math.round(absPos.x / settings.snapGridSize) * settings.snapGridSize;
  let absY = result.snapY ?? Math.round(absPos.y / settings.snapGridSize) * settings.snapGridSize;
  const parentId = memberParentId(base);
  const parent = parentId ? nodeById.get(parentId) : undefined;
  if (parent) {
    absX -= parent.position.x;
    absY -= parent.position.y;
  }
  return { position: { x: absX, y: absY }, guides: result.guides };
}
