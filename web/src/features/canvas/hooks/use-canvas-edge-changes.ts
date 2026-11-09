/**
 * 边变更 hook：React Flow 的 EdgeChange 写回受控 store。
 *
 * 以 store 实时状态为基底，避免同一帧内连续派发的多次变更（选中 + 其它）
 * 以过期闭包互相覆盖。
 */
"use client";

import { applyEdgeChanges, type Edge, type EdgeChange } from "@xyflow/react";
import { useCallback } from "react";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

export function useCanvasEdgeChanges() {
  const setEdges = useCanvasStore((s) => s.setEdges);

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      setEdges(applyEdgeChanges(changes, useCanvasStore.getState().edges));
    },
    [setEdges],
  );

  return { handleEdgesChange };
}
