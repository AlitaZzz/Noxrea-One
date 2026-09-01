/**
 * 宫格切分：将图片按行列切分为多个子图，上传并创建派生节点。
 *
 * 链路与拖放素材上传一致（乐观 UI）：本地切图后先批量建占位节点并连线，
 * 画布上立刻出现全部格子（显示本地预览与上传进度），再并发上传；
 * 上传成功原地替换 src，失败则移除对应节点并提示，不再静默丢图。
 */
"use client";

import { useCallback } from "react";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { showGlobalMessage } from "@/lib/global-message";
import i18n from "@/lib/i18n/config";
import {
  canvasToBlob,
  computeDerivedGrid,
  createOptimisticDerivedNodes,
  type DerivedNodeInput,
  gridPositionAt,
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

        // 1) 本地逐格切图：纯 canvas 操作，不涉及网络
        const items: DerivedNodeInput[] = [];
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const blob = await canvasToBlob(pieceW, pieceH, (ctx) => {
              ctx.drawImage(img, c * pieceW, r * pieceH, pieceW, pieceH, 0, 0, pieceW, pieceH);
            });
            items.push({
              blob,
              naturalWidth: pieceW,
              naturalHeight: pieceH,
              filename: `grid_${r}_${c}.png`,
              labelOverride: `宫格切分 (${r + 1}-${c + 1})`,
              position: gridPositionAt(layout, r * cols + c),
            });
          }
        }

        // 2) 先建占位节点再并发上传：格子立刻上画布，替代原先「切一块传一块」的串行等待
        const { settled } = createOptimisticDerivedNodes(
          sourceId,
          items,
          useCanvasStore.getState(),
          { source: "derived" },
        );
        const { failed, reason } = await settled;
        if (failed > 0) {
          showGlobalMessage().error(reason ?? i18n.t("file.uploadFailed"));
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
