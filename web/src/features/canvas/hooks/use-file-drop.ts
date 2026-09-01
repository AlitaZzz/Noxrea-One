/**
 * 文件拖入画布 hook。
 * 拖放时先创建占位节点再异步上传，成功后原地替换内容、失败则移除占位；
 * 多文件按网格排布。上传与落库统一走 features/canvas/upload 的上传管道。
 */
"use client";

import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";

import { detectMediaKind, runMediaUpload, type UploadItem } from "@/features/canvas/upload";
import {
  AUDIO_NODE_HEIGHT,
  AUDIO_NODE_WIDTH,
  DEFAULT_NODE_CONTENT_HEIGHT,
  DEFAULT_NODE_WIDTH,
  LAYOUT_GAP,
} from "@/lib/constants";
import { computeNodeSize, loadMediaDimensions } from "@/lib/utils/image-utils";

const GRID_COLS = 4;

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
 * @returns { handleDragOver, handleDrop, isFileDragging } 供 JSX 绑定
 */
export function useFileDrop(
  screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number },
  shouldIgnore?: (target: HTMLElement) => boolean,
  containerRef?: React.RefObject<HTMLElement | null>,
) {
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

      // 1) 先从本地 blob URL 预加载图片/视频尺寸，再按正确尺寸计算网格落点
      const items: UploadItem[] = [];
      // 网格落点游标：按每个文件的实际显示尺寸逐行累加（行满 GRID_COLS 换行），
      // 任意比例混合拖入时间距恒为 LAYOUT_GAP 且互不遮挡
      let cursorX = pos.x;
      let cursorY = pos.y;
      let rowMaxH = 0;
      let colInRow = 0;

      for (const file of files) {
        const kind = detectMediaKind(file, file.name);
        // 不支持的类型原样交给管道，由它统一计数并提示
        if (!kind) {
          items.push({ blob: file, filename: file.name });
          continue;
        }

        let previewUrl: string | undefined;
        let nw = 0;
        let nh = 0;
        let nodeW = AUDIO_NODE_WIDTH;
        let nodeH = AUDIO_NODE_HEIGHT;

        if (kind !== "audio") {
          previewUrl = URL.createObjectURL(file);
          const dims = await loadMediaDimensions(previewUrl, kind === "video");
          nw = dims.w || (kind === "video" ? 1280 : DEFAULT_NODE_WIDTH);
          nh = dims.h || (kind === "video" ? 720 : DEFAULT_NODE_CONTENT_HEIGHT);
          const { width, height } = computeNodeSize(nw, nh);
          nodeW = width;
          nodeH = height;
        }

        // 2) 行满换行：y 前进一行（行高 = 该行最大节点高度 + 间距）
        if (colInRow >= GRID_COLS) {
          cursorX = pos.x;
          cursorY += rowMaxH + LAYOUT_GAP;
          rowMaxH = 0;
          colInRow = 0;
        }

        // 3) 落点 = 当前游标；游标按实际尺寸前进
        items.push({
          blob: file,
          filename: file.name,
          nodeType: kind,
          naturalWidth: nw,
          naturalHeight: nh,
          previewUrl,
          position: { x: cursorX, y: cursorY },
        });

        cursorX += nodeW + LAYOUT_GAP;
        rowMaxH = Math.max(rowMaxH, nodeH);
        colInRow++;
      }

      // 2) 交给统一上传管道：建占位 → 并发上传 → 成功落库 / 失败移除并提示
      await runMediaUpload({ items, sink: { kind: "create-node" } });
    },
    [screenToFlowPosition, shouldIgnore, stopWatcher],
  );

  return { handleDragOver, handleDrop, isFileDragging };
}
