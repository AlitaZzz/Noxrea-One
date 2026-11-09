/**
 * 节点变更流 hook：React Flow 的 NodeChange 在这里分流。
 *
 * - 位置帧：拖动过程帧交给 DragPreviewSession 预览（只写 DOM），终态帧提交；
 *   会话未激活（程序化位置变更）时直接写 store；
 * - 其余变更（选中、实测尺寸）：写受控 store；缩放会话活动节点的尺寸回传由
 *   会话消费，不在这里重复写 store。
 *
 * 处理器始终读取 store 实时状态：同一渲染帧内 React Flow 可能连续派发多次
 * 变更（选中 + 位置/尺寸），用渲染期闭包作基底会覆盖前一次写入。
 */
"use client";

import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import { useCallback } from "react";

import type { DragPreviewSession } from "@/features/canvas/drag/drag-preview-session";
import { routePositionFrames } from "@/features/canvas/drag/position-routing";
import { isTidyAnimating, useTidyAnimation } from "@/features/canvas/hooks/use-tidy-animation";
import type { ResizeSession } from "@/features/canvas/resize/resize-session";
import { selectCanvasStateChanges } from "@/features/canvas/shared/node-changes";
import {
  applyNodePositions,
  type PositionFrame,
  toPositionMap,
} from "@/features/canvas/shared/node-positions";
import { markDirty, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";

export interface UseCanvasNodeChangesOptions {
  dragSession: DragPreviewSession;
  resizeSession: ResizeSession;
}

export function useCanvasNodeChanges({
  dragSession,
  resizeSession,
}: UseCanvasNodeChangesOptions) {
  const setNodes = useCanvasStore((s) => s.setNodes);
  // 整理动画的取消与卸载清理属于位置写入方：用户拖动一旦产生位置帧即让路
  const { cancel: cancelTidy } = useTidyAnimation();

  /** 直接写入口径：会话未激活时的位置帧兜底（无拖动开始的程序化位置变更） */
  const applyPositionFrames = useCallback(
    (frames: PositionFrame[]) => {
      const positions = toPositionMap(frames);
      const { nodes: next, changed } = applyNodePositions(
        useCanvasStore.getState().nodes,
        positions,
      );
      if (!changed) return;
      setNodes(next);
      markDirty();
    },
    [setNodes],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<AnyNode>[]) => {
      // Zustand 是受控 React Flow 的唯一真源，但拖动位置帧不写 store：
      // 预览会话按 rAF 合并后只写 DOM，松手时一次提交（drag/drag-preview-session.ts）。
      const stateChanges = selectCanvasStateChanges(changes);
      if (stateChanges.length === 0) return;

      const positionChanges = stateChanges.filter(
        (c): c is Extract<NodeChange<AnyNode>, { type: "position" }> => c.type === "position",
      );
      if (isTidyAnimating() && positionChanges.length > 0) {
        cancelTidy();
      }

      // 过程帧只进会话预览（不写 store），终态帧是提交点（规则 1.2、1.4）
      routePositionFrames(positionChanges, dragSession, applyPositionFrames);

      // 选中 / 实测尺寸等其余变更照常写 store；位置变更已由会话或兜底路径处理。
      // 缩放会话活动的节点：ResizeObserver 的尺寸回传由会话消费，否则预览期
      // 会再写一次 store（规则 3.1）
      const otherChanges = stateChanges.filter(
        (c) =>
          c.type !== "position" &&
          !(c.type === "dimensions" && resizeSession.isResizingNode(c.id)),
      );
      if (otherChanges.length > 0) {
        setNodes(applyNodeChanges(otherChanges, useCanvasStore.getState().nodes));
      }
    },
    [applyPositionFrames, cancelTidy, dragSession, resizeSession, setNodes],
  );

  return { handleNodesChange };
}
