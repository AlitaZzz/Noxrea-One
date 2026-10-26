/**
 * 宫格切分：将图片按行列切分为多个子图，上传并创建派生节点。
 *
 * 走统一上传管道：本地切图后先批量建占位节点并连线，
 * 画布上立刻出现全部格子（显示本地预览与上传进度），再并发上传；
 * 上传成功原地替换 src，失败则移除对应节点并提示，不再静默丢图。
 */
"use client";

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { toAbsoluteNodes } from "@/features/canvas/shared/group-bounds";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { runMediaUpload, type UploadItem } from "@/features/canvas/upload";
import { loadMediaImage } from "@/lib/load-media-image";
import { canvasToBlob, computeDerivedGrid, findDerivedBatchOrigin, gridPositionAt } from "@/lib/utils/image-utils";

export function useGridSplit(sourceId: string, src: string | undefined) {
  const { t } = useTranslation();
  const { notification } = useAppFeedback();
  return useCallback(
    async (rows: number, cols: number) => {
      if (!src) return;
      try {
        // 切图要的是「执行这一刻」的像素：地址在动作时解析，元素失败按规则 3.6 刷新一次。
        // 不复用挂载时的结果——长驻节点的签名可能早已过期
        const img = await loadMediaImage(src);

        const pieceW = img.naturalWidth / cols;
        const pieceH = img.naturalHeight / rows;

        // Get original node position for grid layout（绝对坐标视图：源节点可能是组成员）
        const store = useCanvasStore.getState();
        const absNodes = toAbsoluteNodes(store.nodes);
        const origNode = absNodes.find((n) => n.id === sourceId);
        const layout = computeDerivedGrid(origNode, pieceW, pieceH, cols);
        // 目标区域被占（上一批切分 / 用户手动摆放）时整批平移到空区域
        const origin = findDerivedBatchOrigin(absNodes, layout, rows * cols);
        layout.baseX = origin.x;
        layout.baseY = origin.y;

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
              labelSuffix: t("node.gridSplitSuffix", { index: `${r + 1}-${c + 1}` }),
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
        // 用户发起的动作失败必须有可见反馈：静默返回看起来就是按钮坏了（规则 3.7）
        console.error("grid-split failed:", e);
        notification.error({ title: t("node.gridSplitFailed"), key: `grid-split-${sourceId}` });
      } finally {
        useCanvasStore
          .getState()
          .updateNodeData(sourceId, { taskBinding: undefined }, undefined, { skipHistory: true });
      }
    },
    [sourceId, src, t, notification],
  );
}
