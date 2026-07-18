"use client";

import { useCallback, type DragEvent } from "react";
import { useCanvasStore, takeCanvasSnapshot } from "@/stores/canvas-store";
import { useHistoryStore } from "@/stores/history-store";
import { apiUpload } from "@/lib/api";
import { createImageNode, createVideoNode } from "@/lib/node-defaults";
import { applyThumbnailSettings, computeThumbScale, loadMediaDimensions } from "@/lib/image-utils";
import { useI18nStore } from "@/stores/i18n-store";

const GRID_COLS = 4;
const GRID_GAP = 30;

/**
 * 文件拖放 hook。
 *
 * 支持多文件拖放：图片 → ImageNode，视频 → VideoNode。
 * 节点以网格排列，每行最多 GRID_COLS 个，超出自动换行。
 * 部分上传失败时不影响其他文件。
 *
 * @param screenToFlowPosition  React Flow 的屏幕坐标→画布坐标转换函数
 * @param notif  antd App.useApp() 返回的 notification 实例（可选，传了则在部分失败时显示提示）
 * @returns { handleDragOver, handleDrop } 供 JSX 绑定
 */
export function useFileDrop(
  screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number },
  notif?: { error: Function; warning?: Function; info?: Function },
) {
  const pushHistory = useHistoryStore((s) => s.push);
  const addNodes = useCanvasStore((s) => s.addNodes);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length === 0) return;

      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });

      const results = await Promise.allSettled(
        files.map(async (file, index) => {
          const col = index % GRID_COLS;
          const row = Math.floor(index / GRID_COLS);

          if (file.type.startsWith("image/")) {
            const formData = new FormData();
            formData.append("file", file);
            const res = await apiUpload<{ url: string }>("/api/files/upload?category=images", formData);
            if (res.code !== 200 || !res.data?.url) return null;

            const dims = await loadMediaDimensions(res.data.url, false);
            if (!dims.w || !dims.h) return null;

            const { displayW, displayH } = computeThumbScale(dims.w, dims.h);
            const node = createImageNode(
              { x: pos.x + col * (displayW + GRID_GAP), y: pos.y + row * (displayH + 24 + GRID_GAP) },
              res.data.url,
            );
            applyThumbnailSettings(node, dims.w, dims.h, file.name);
            return node;

          } else if (file.type.startsWith("video/")) {
            const formData = new FormData();
            formData.append("file", file);
            const res = await apiUpload<{ url: string }>("/api/files/upload?category=videos", formData);
            if (res.code !== 200 || !res.data?.url) return null;

            const dims = await loadMediaDimensions(res.data.url, true);
            const nw = dims.w || 1280;
            const nh = dims.h || 720;
            const { displayW, displayH } = computeThumbScale(nw, nh);
            const node = createVideoNode(
              { x: pos.x + col * (displayW + GRID_GAP), y: pos.y + row * (displayH + 24 + GRID_GAP) },
              res.data.url,
            );
            applyThumbnailSettings(node, nw, nh, file.name);
            return node;

          } else {
            return null;
          }
        }),
      );

      const createdNodes = results
        .filter((r) => r.status === "fulfilled" && r.value !== null)
        .map((r) => (r as PromiseFulfilledResult<any>).value);

      if (createdNodes.length > 0) {
        pushHistory(takeCanvasSnapshot());
        addNodes(createdNodes);
      }

      const failedCount = files.length - createdNodes.length;
      if (failedCount > 0 && notif) {
        const t = useI18nStore.getState().t;
        const description = createdNodes.length > 0
          ? `${failedCount}/${files.length}`
          : t("file.upload.failed.all");
        notif.error({ title: t("file.upload.failed"), description, placement: "bottomRight", duration: 4 });
      }
    },
    [screenToFlowPosition, pushHistory, addNodes],
  );

  return { handleDragOver, handleDrop };
}
