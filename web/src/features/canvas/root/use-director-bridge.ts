"use client";

import { useCallback, useMemo } from "react";

import type { DirectorImageNodeInput, DirectorStateData } from "@/entities/director";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { createImageNodeFromRef } from "@/features/canvas/upload/derived-node";

export interface DirectorBridge {
  /** 当前 Director 节点保存的场景快照；节点不存在时为 null。 */
  initialState: DirectorStateData | null;
  onSaveState: (state: DirectorStateData) => void;
  onCreateImageNode: (input: DirectorImageNodeInput) => Promise<void>;
}

/**
 * 页面与 Director 全屏编辑器之间的桥：节点身份由页面持有，画布决定
 * 派生节点的落位与默认值；节点被删除后所有动作安全地退化为 no-op。
 */
export function useDirectorBridge(directorNodeId: string | null): DirectorBridge {
  const initialState = useCanvasStore((s) => {
    if (!directorNodeId) return null;
    const node = s.nodes.find((n) => n.id === directorNodeId);
    return (node?.data as { directorState?: DirectorStateData } | undefined)?.directorState ?? null;
  });

  const onSaveState = useCallback(
    (state: DirectorStateData) => {
      if (!directorNodeId) return;
      const store = useCanvasStore.getState();
      if (!store.nodes.some((n) => n.id === directorNodeId)) return;
      store.updateNodeData(directorNodeId, { directorState: state });
    },
    [directorNodeId],
  );

  const onCreateImageNode = useCallback(
    async (input: DirectorImageNodeInput) => {
      if (!directorNodeId) return;
      const store = useCanvasStore.getState();
      if (!store.nodes.some((n) => n.id === directorNodeId)) return;
      createImageNodeFromRef({
        sourceId: directorNodeId,
        ref: input.ref,
        naturalWidth: input.width,
        naturalHeight: input.height,
        labelSuffix: input.name,
        storeApi: store,
        extraNodeData: { source: "derived" },
        labelOverride: input.name,
      });
    },
    [directorNodeId],
  );

  return useMemo(
    () => ({ initialState, onSaveState, onCreateImageNode }),
    [initialState, onCreateImageNode, onSaveState],
  );
}
