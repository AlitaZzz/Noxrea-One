/**
 * 文件拖入画布 hook。
 * 拖放时先创建占位节点再异步上传，成功后原地替换内容、失败则移除占位；
 * 多文件按网格排布。
 */
"use client";

import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";

import { createAudioNode, createImageNode, createVideoNode } from "@/features/canvas/node-defaults";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AudioNode, ImageNode, VideoNode } from "@/features/canvas/types";
import { AUDIO_NODE_HEIGHT, AUDIO_NODE_WIDTH, DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH } from "@/lib/constants";
import { showGlobalMessage } from "@/lib/global-message";
import i18n from "@/lib/i18n/config";
import { computeNodeSize, loadMediaDimensions } from "@/lib/utils/image-utils";
import { getUploadErrorDetail, runWithConcurrency, uploadWithRetry } from "@/lib/utils/upload";

const GRID_COLS = 4;
const GRID_GAP = 30;

/** 参考区缩略图拖拽的自定义标记：携带此类标记的拖拽一律不视为文件上传 */
const REF_DRAG_TYPES = ["application/x-ref-image", "application/x-ref-video", "application/x-ref-audio"];

function isRefDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return REF_DRAG_TYPES.some((k) => dt.types.includes(k));
}

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
  containerRef?: React.RefObject<HTMLElement | null>,
) {
  const addNodes = useCanvasStore((s) => s.addNodes);
  const removeNodes = useCanvasStore((s) => s.removeNodes);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);

  // 组件卸载时清理心跳定时器
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // 用「window 级 dragover 心跳」判定拖拽是否仍在画布内：
  // 因为 React Flow 节点会在 dragover 上 stopPropagation，导致拖到节点上方时
  // 画布容器的 onDragOver 收不到事件、心跳停止从而遮罩消失。
  // 改为监听 window（捕获阶段，节点无法拦截），只要坐标仍在画布容器内就刷新心跳，
  // 定时器超时即隐藏遮罩。该方案不依赖任何「离开事件」的可靠性。
  const [isFileDragging, setFileDragging] = useState(false);
  const lastActiveRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const draggingRef = useRef(false); // 当前是否处于文件拖拽中（首次进入时置位）

  const isInsideCanvas = useCallback(
    (e: globalThis.DragEvent) => {
      if (!containerRef?.current) return true; // 无 ref 时退化为「命中即显示」
      const rect = containerRef.current.getBoundingClientRect();
      const { clientX: x, clientY: y } = e;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    },
    [containerRef],
  );

  // 监听 window 上的 dragover（捕获），只要携带文件且仍在画布内就刷新心跳
  useEffect(() => {
    const onWindowDragOver = (e: globalThis.DragEvent) => {
      if (!draggingRef.current) return;
      if (isRefDrag(e.dataTransfer)) return;
      if (!e.dataTransfer?.types.includes("Files")) return;
      if (shouldIgnore?.(e.target as HTMLElement)) return;
      if (!isInsideCanvas(e)) return;
      lastActiveRef.current = Date.now();
      if (!isFileDragging) setFileDragging(true);
    };
    window.addEventListener("dragover", onWindowDragOver, true);
    return () => window.removeEventListener("dragover", onWindowDragOver, true);
  }, [shouldIgnore, isInsideCanvas, isFileDragging]);

  const startWatcher = useCallback(() => {
    draggingRef.current = true;
    lastActiveRef.current = Date.now();
    setFileDragging(true);
    if (timerRef.current) return;
    // eslint-disable-next-line react-hooks/immutability -- timerRef 为定时器 ID 容器，事件回调中管理属标准用法；effect 清理会读取它，此处为已知误报
    timerRef.current = setInterval(() => {
      // 超过 120ms 未收到画布内的 dragover，判定已离开
      if (Date.now() - lastActiveRef.current > 120) {
        draggingRef.current = false;
        setFileDragging(false);
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      }
    }, 60);
  }, []);

  const stopWatcher = useCallback(() => {
    draggingRef.current = false;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      // eslint-disable-next-line react-hooks/immutability -- timerRef 为定时器 ID 容器，事件回调中管理属标准用法；effect 清理会读取它，此处为已知误报
      timerRef.current = null;
    }
    setFileDragging(false);
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    if (shouldIgnore?.(e.target as HTMLElement)) return;
    // 参考区缩略图排序拖拽（或任何非文件拖拽）不触发上传遮罩与放置行为
    if (isRefDrag(e.dataTransfer) || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    startWatcher();
  }, [shouldIgnore, startWatcher]);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      if (shouldIgnore?.(e.target as HTMLElement)) return;
      // 参考区缩略图排序拖拽落到画布：不作为文件上传处理
      if (isRefDrag(e.dataTransfer)) return;
      e.preventDefault();
      // 释放后隐藏遮罩并停止心跳定时器
      stopWatcher();
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length === 0) return;

      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });

      // 1) 先从本地 blob URL 预加载图片/视频尺寸，再按正确尺寸创建节点
      const placeholders: { node: AudioNode | ImageNode | VideoNode; file: File; idx: number }[] = [];
      let ignoredCount = 0; // 不被支持的文件数量，用于后续提示
      let mediaIdx = 0;
      for (let idx = 0; idx < files.length; idx++) {
        const file = files[idx];
        const isImage = file.type.startsWith("image/");
        const isVideo = file.type.startsWith("video/");
        const isAudio = file.type.startsWith("audio/");
        if (!isImage && !isVideo && !isAudio) {
          ignoredCount++;
          continue;
        }

        const col = mediaIdx % GRID_COLS;
        const row = Math.floor(mediaIdx / GRID_COLS);
        const px = pos.x + col * (DEFAULT_NODE_WIDTH + GRID_GAP);
        const py = pos.y + row * (DEFAULT_NODE_HEIGHT + 24 + GRID_GAP);
        mediaIdx++;

        if (isImage || isVideo) {
          const previewUrl = URL.createObjectURL(file);
          const dims = await loadMediaDimensions(previewUrl, isVideo);
          const nw = dims.w || (isVideo ? 1280 : DEFAULT_NODE_WIDTH);
          const nh = dims.h || (isVideo ? 720 : DEFAULT_NODE_HEIGHT);
          const { width, height } = computeNodeSize(nw, nh);

          const node = isImage ? createImageNode({ x: px, y: py }, "") : createVideoNode({ x: px, y: py }, "");
          node.data.label = file.name;
          node.data.alt = file.name;
          node.data.naturalWidth = nw;
          node.data.naturalHeight = nh;
          node.data.source = "upload";
          node.data.upload = { uploading: true, progress: 0, version: 0, previewUrl };
          node.style = { width, height };
          placeholders.push({ node, file, idx });
        } else {
          const node = createAudioNode({ x: px, y: py }, "");
          node.data.label = file.name;
          node.data.alt = file.name;
          node.data.source = "upload";
          node.data.upload = { uploading: true, progress: 0, version: 0 };
          placeholders.push({ node, file, idx });
        }
      }

      if (placeholders.length === 0) {
        // 全部为不支持的文件类型：用顶部居中的轻提示（message），
        // 与「保存/配置校验」等用户操作反馈保持一致，而非右下角系统级通知
        showGlobalMessage().error(i18n.t("file.unsupportedType"));
        return;
      }

      // 混合拖放：支持的已照常上传，被忽略的不支持文件提示一次（不列具体文件名）
      if (ignoredCount > 0) {
        showGlobalMessage().error(i18n.t("file.ignoredSome"));
      }
      const placeholderNodes = placeholders.map((p) => p.node);
      addNodes(placeholderNodes);

      // 2) 异步上传，限制并发数避免 dev 代理层 ETIMEDOUT
      const failed: { id: string; reason?: string }[] = [];
      await runWithConcurrency(
        placeholders.map(({ node, file }) => async () => {
          const isVideo = file.type.startsWith("video/");
          const isAudio = file.type.startsWith("audio/");
          const category = isVideo ? "videos" : isAudio ? "audios" : "images";

          try {
            const result = await uploadWithRetry(file, category, (pct) => {
              const cur = useCanvasStore.getState().nodes.find((n) => n.id === node.id);
              const previewUrl = (cur?.data as { upload?: { previewUrl?: string } })?.upload?.previewUrl;
              updateNodeData(node.id, { upload: { uploading: true, progress: pct, version: 0, previewUrl } }, undefined, { skipHistory: true });
            });

            // 释放预览 blob URL
            const curNode = useCanvasStore.getState().nodes.find((n) => n.id === node.id);
            const oldPreview = (curNode?.data as { upload?: { previewUrl?: string } })?.upload?.previewUrl;
            if (oldPreview?.startsWith("blob:")) URL.revokeObjectURL(oldPreview);

            if (isAudio) {
              // 音频无固定宽高，使用固定节点尺寸；duration 由节点 onLoadedMetadata 回填
              updateNodeData(node.id, {
                src: result.url,
                label: file.name,
                alt: file.name,
                upload: undefined,
              }, { width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT }, { skipHistory: true });
              return;
            }

            const dims = await loadMediaDimensions(result.url, isVideo);
            const nw = dims.w || (isVideo ? 1280 : DEFAULT_NODE_WIDTH);
            const nh = dims.h || (isVideo ? 720 : DEFAULT_NODE_HEIGHT);

            const { width, height } = computeNodeSize(nw, nh);
            updateNodeData(node.id, {
              src: result.url,
              naturalWidth: nw,
              naturalHeight: nh,
              upload: undefined,
              source: "upload",
            }, { width, height }, { skipHistory: true });
          } catch (err) {
            // 释放预览 blob URL
            const curNode = useCanvasStore.getState().nodes.find((n) => n.id === node.id);
            const oldPreview = (curNode?.data as { upload?: { previewUrl?: string } })?.upload?.previewUrl;
            if (oldPreview?.startsWith("blob:")) URL.revokeObjectURL(oldPreview);
            failed.push({ id: node.id, reason: getUploadErrorDetail(err) });
          }
        }),
      );

      // 3) 删除上传失败的占位节点
      if (failed.length > 0) {
        removeNodes(failed.map((f) => f.id), { skipHistory: true });
      }
      const successCount = placeholderNodes.length - failed.length;
      if (successCount === 0 && notif) {
        const t = i18n.t;
        // 全部失败时，优先显示服务端返回的具体原因
        const reason = failed.find((f) => f.reason)?.reason;
        notif.error({
          title: t("file.uploadFailed"),
          description: reason ?? t("file.uploadFailedAll"),
          placement: "bottomRight",
          duration: 4,
        });
      } else if (failed.length > 0 && notif) {
        const t = i18n.t;
        const reason = failed.find((f) => f.reason)?.reason;
        notif.error({
          title: t("file.uploadFailed"),
          description: reason ? `${failed.length}/${files.length} - ${reason}` : `${failed.length}/${files.length}`,
          placement: "bottomRight",
          duration: 4,
        });
      }
    },
    [addNodes, removeNodes, updateNodeData, screenToFlowPosition, shouldIgnore],
  );

  return { handleDragOver, handleDrop, isFileDragging };
}
