/**
 * 宫格切分：将图片按行列切分为多个子图，上传并创建派生节点。
 *
 * 走统一上传管道：本地切图后先批量建占位节点并连线，
 * 画布上立刻出现全部格子（显示本地预览与上传进度），再并发上传；
 * 上传成功原地替换 src，失败则移除对应节点并提示，不再静默丢图。
 */
"use client";

import { useCallback } from "react";

import { runMediaUpload, type UploadItem } from "@/features/canvas/upload";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { canvasToBlob, computeDerivedGrid, gridPositionAt } from "@/lib/utils/image-utils";

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

        // 1) 本地逐格切图：纯 canvas 操作，不涉及网络
        const items: UploadItem[] = [];
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const blob = await canvasToBlob(pieceW, pieceH, (ctx) => {
              ctx.drawImage(img, c * pieceW, r * pieceH, pieceW, pieceH, 0, 0, pieceW, pieceH);
            });
            items.push({
              blob,
              filename: `grid_${r}_${c}.png`,
              naturalWidth: pieceW,
              naturalHeight: pieceH,
              label: `宫格切分 (${r + 1}-${c + 1})`,
              position: gridPositionAt(layout, r * cols + c),
            });
          }
        }

        // 2) 先建占位节点再并发上传：格子立刻上画布，替代原先「切一块传一块」的串行等待
        await runMediaUpload({
          items,
          sink: { kind: "derived-node", sourceId },
        });
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
