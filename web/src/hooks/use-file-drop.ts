/**
 * 文件拖入画布 hook。
 * 拖放时先创建占位节点再异步上传，成功后原地替换内容、失败则移除占位；
 * 多文件按网格排布。
 */
"use client";

import { type DragEvent,useCallback } from "react";

import { createAudioNode, createImageNode, createVideoNode } from "@/features/canvas/node-defaults";
import { apiUploadWithProgress } from "@/lib/api";
import { AUDIO_NODE_HEIGHT, AUDIO_NODE_WIDTH, DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH } from "@/lib/constants";
import { computeNodeSize, loadMediaDimensions } from "@/lib/image-utils";
import type { AudioNode, ImageNode, VideoNode } from "@/lib/types/nodes";
import { useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";

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
  shouldIgnore?: (target: HTMLElement) => boolean,
) {
  const addNodes = useCanvasStore((s) => s.addNodes);
  const removeNodes = useCanvasStore((s) => s.removeNodes);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);

  const handleDragOver = useCallback((e: DragEvent) => {
    if (shouldIgnore?.(e.target as HTMLElement)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, [shouldIgnore]);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      if (shouldIgnore?.(e.target as HTMLElement)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length === 0) return;

      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });

      // 1) 立刻创建占位节点（默认尺寸），先给用户"有反应"的反馈
      const placeholders: { node: AudioNode | ImageNode | VideoNode; file: File; idx: number }[] = [];
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
          node.data.upload = { uploading: true, progress: 0, version: 0 };
          placeholders.push({ node, file, idx });
        } else if (file.type.startsWith("video/")) {
          const node = createVideoNode({ x: px, y: py }, "");
          node.data.label = file.name;
          node.data.alt = file.name;
          node.data.upload = { uploading: true, progress: 0, version: 0 };
          placeholders.push({ node, file, idx });
        } else if (file.type.startsWith("audio/")) {
          const node = createAudioNode({ x: px, y: py }, "");
          node.data.label = file.name;
          node.data.alt = file.name;
          node.data.upload = { uploading: true, progress: 0, version: 0 };
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
            const isAudio = file.type.startsWith("audio/");
            const category = isVideo ? "videos" : isAudio ? "audios" : "images";
            const formData = new FormData();
            formData.append("file", file);
            const res = await apiUploadWithProgress<{ url: string }>(`/api/files/upload?category=${category}`, formData, (pct) => {
              updateNodeData(node.id, { upload: { uploading: true, progress: pct, version: 0 } }, undefined, { skipHistory: true });
            });
            if (res.code !== 200 || !res.data?.url) { failedIds.push(node.id); return; }

            if (isAudio) {
              // 音频无固定宽高，使用固定节点尺寸；duration 由节点 onLoadedMetadata 回填
              updateNodeData(node.id, {
                src: res.data.url,
                label: file.name,
                alt: file.name,
                upload: undefined,
              }, { width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT }, { skipHistory: true });
              return;
            }

            const dims = await loadMediaDimensions(res.data.url, isVideo);
            const nw = dims.w || (isVideo ? 1280 : DEFAULT_NODE_WIDTH);
            const nh = dims.h || (isVideo ? 720 : DEFAULT_NODE_HEIGHT);

            const { width, height } = computeNodeSize(nw, nh);
            updateNodeData(node.id, {
              src: res.data.url,
              naturalWidth: nw,
              naturalHeight: nh,
              upload: undefined,
            }, { width, height }, { skipHistory: true });
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
    [addNodes, removeNodes, updateNodeData, screenToFlowPosition, shouldIgnore],
  );

  return { handleDragOver, handleDrop };
}
