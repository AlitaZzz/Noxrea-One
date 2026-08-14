/**
 * 宫格切分：将图片按行列切分为多个子图，上传并创建派生节点。
 */
"use client";

import { useCallback } from "react";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import {
  canvasToBlob,
  computeDerivedGrid,
  createNodeFromUrl,
  gridPositionAt,
  uploadBlob,
} from "@/lib/utils/image-utils";

export function useGridSplit(sourceId: string, src: string | undefined) {
  return useCallback(
    async (rows: number, cols: number) => {
      if (!src) return;
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new window.Image();
          img.crossOrigin = "anonymous";
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("Failed to load image"));
          img.src = src;
        });

        const pieceW = img.naturalWidth / cols;
        const pieceH = img.naturalHeight / rows;

        // Get original node position for grid layout
        const origNode = useCanvasStore.getState().nodes.find((n) => n.id === sourceId);
        const layout = computeDerivedGrid(origNode, pieceW, pieceH, cols);

        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const blob = await canvasToBlob(pieceW, pieceH, (ctx) => {
              ctx.drawImage(img, c * pieceW, r * pieceH, pieceW, pieceH, 0, 0, pieceW, pieceH);
            });
            const url = await uploadBlob(blob, `grid_${r}_${c}.png`, "derived");
            if (!url) continue;

            const pos = gridPositionAt(layout, r * cols + c);
            await createNodeFromUrl(
              sourceId,
              url,
              pieceW,
              pieceH,
              ` (${r + 1}-${c + 1})`,
              useCanvasStore.getState(),
              { source: "derived" },
              pos,
            );
          }
        }
      } catch (e) {
        console.error("grid-split failed:", e);
      } finally {
        useCanvasStore
          .getState()
          .updateNodeData(sourceId, { taskBinding: undefined }, undefined, { skipHistory: true });
      }
    },
    [sourceId, src],
  );
}
