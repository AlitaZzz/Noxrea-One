"use client";

import { useCallback, type DragEvent } from "react";
import { useCanvasStore } from "@/stores/canvas-store";
import { apiUpload } from "@/lib/api";
import { createImageNode, createVideoNode } from "@/lib/node-defaults";
import { computeThumbScale, loadMediaDimensions } from "@/lib/image-utils";
import { useI18nStore } from "@/stores/i18n-store";
import { DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT } from "@/lib/constants";

const GRID_COLS = 4;
const GRID_GAP = 30;

/**
 * 文件拖放 hook。
 *
 * 拖放时**立刻**在画布上创建占位节点（src=""），再异步上传文件。
 * 上传成功后用 updateNodeData 原地替换为真实内容；失败则删除占位节点。
 *
 * @param screenToFlowPosition  React Flow 的屏幕坐标→画布坐标转换函数
 * @param notif  antd App.useApp() 返回的 notification 实例（可选）
 * @returns { handleDragOver, handleDrop } 供 JSX 绑定
 */
export function useFileDrop(
  screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number },
  notif?: { error: Function; warning?: Function; info?: Function },
) {
  const addNodes = useCanvasStore((s) => s.addNodes);
  const removeNodes = useCanvasStore((s) => s.removeNodes);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);

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

      // 1) 立刻创建占位节点（默认尺寸），先给用户"有反应"的反馈
      const placeholders: { node: ReturnType<typeof createImageNode>; file: File; idx: number }[] = [];
      for (let idx = 0; idx < files.length; idx++) {
        const file = files[idx];
        const col = idx % GRID_COLS;
        const row = Math.floor(idx / GRID_COLS);
        const px = pos.x + col * (DEFAULT_NODE_WIDTH + GRID_GAP);
        const py = pos.y + row * (DEFAULT_NODE_HEIGHT + 24 + GRID_GAP);

        if (file.type.startsWith("image/")) {
          const node = createImageNode({ x: px, y: py }, "");
          node.data.label = file.name;
          node.data.alt = file.name;
          placeholders.push({ node, file, idx });
        } else if (file.type.startsWith("video/")) {
          const node = createVideoNode({ x: px, y: py }, "");
          node.data.label = file.name;
          node.data.alt = file.name;
          placeholders.push({ node, file, idx });
        }
      }

      if (placeholders.length === 0) return;
      const placeholderNodes = placeholders.map((p) => p.node);
      addNodes(placeholderNodes);

      // 2) 异步上传，逐个替换占位节点
      const failedIds: string[] = [];
      await Promise.allSettled(
        placeholders.map(async ({ node, file }) => {
          try {
            const isVideo = file.type.startsWith("video/");
            const category = isVideo ? "videos" : "images";
            const formData = new FormData();
            formData.append("file", file);
            const res = await apiUpload<{ url: string }>(`/api/files/upload?category=${category}`, formData);
            if (res.code !== 200 || !res.data?.url) { failedIds.push(node.id); return; }

            const dims = await loadMediaDimensions(res.data.url, isVideo);
            const nw = dims.w || (isVideo ? 1280 : DEFAULT_NODE_WIDTH);
            const nh = dims.h || (isVideo ? 720 : DEFAULT_NODE_HEIGHT);

            const { displayW, displayH } = computeThumbScale(nw, nh);
            const titleH = 24;
            updateNodeData(node.id, {
              src: res.data.url,
              naturalWidth: nw,
              naturalHeight: nh,
            }, { width: displayW, height: displayH + titleH }, { skipHistory: true });
          } catch {
            failedIds.push(node.id);
          }
        }),
      );

      // 3) 删除上传失败的占位节点
      if (failedIds.length > 0) {
        removeNodes(failedIds, { skipHistory: true });
      }
      const successCount = placeholderNodes.length - failedIds.length;
      if (successCount === 0 && notif) {
        const t = useI18nStore.getState().t;
        notif.error({ title: t("file.upload.failed"), description: t("file.upload.failed.all"), placement: "bottomRight", duration: 4 });
      } else if (failedIds.length > 0 && notif) {
        const t = useI18nStore.getState().t;
        notif.error({ title: t("file.upload.failed"), description: `${failedIds.length}/${files.length}`, placement: "bottomRight", duration: 4 });
      }
    },
    [addNodes, removeNodes, updateNodeData, screenToFlowPosition],
  );

  return { handleDragOver, handleDrop };
}
