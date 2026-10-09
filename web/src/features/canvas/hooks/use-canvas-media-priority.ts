"use client";

import { type ReactFlowState, useStore } from "@xyflow/react";

import { type ImagePlacement, placedImageRect } from "@/features/canvas/shared/image-visibility";
import { mediaLoadPriority } from "@/features/canvas/shared/media-visibility";
import { NODE_TITLE_HEIGHT } from "@/lib/constants";

export function useCanvasMediaPriority(nodeId: string, placement: ImagePlacement = {}) {
  const { column = 0, row = 0, stackDepth = 0 } = placement;
  return useStore((state: ReactFlowState) => {
    const node = state.nodeLookup.get(nodeId);
    if (!node || node.hidden) return null;
    // React Flow owns live absolute positions, including parent movement and dragging.
    const { x, y } = node.internals.positionAbsolute;
    const width = node.measured?.width ?? 0;
    const height = (node.measured?.height ?? 0) - NODE_TITLE_HEIGHT;
    return mediaLoadPriority(placedImageRect({ x, y: y + NODE_TITLE_HEIGHT, width, height }, { column, row, stackDepth }), state);
  });
}
