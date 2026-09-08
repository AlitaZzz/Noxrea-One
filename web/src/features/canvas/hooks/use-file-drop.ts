/**
 * 文件拖入画布 hook。
 * 拖放时先创建占位节点再异步上传，成功后原地替换内容、失败则移除占位；
 * 多文件按网格排布。上传与落库统一走 features/canvas/upload 的上传管道。
 */
"use client";

import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";

import { createNodesFromFiles } from "@/features/canvas/upload";

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
    // 非文件拖拽（画布内元素 / 选中文本的原生拖拽）：不弹上传遮罩、也不建节点，
    // 但仍必须 preventDefault —— 否则浏览器判定「此处不可放置」，光标变成禁止图标。
    // dropEffect 置为 none，明确表示不接受放置（handleDrop 对这些类型同样放行）。
    if (isRefDrag(e.dataTransfer) || !e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
      return;
    }
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
      // 共享的「本地文件 → 新节点」落位 + 上传逻辑（右键菜单上传也走这里）
      await createNodesFromFiles(files, pos);
    },
    [screenToFlowPosition, shouldIgnore, stopWatcher],
  );

  /**
   * 阻止画布内元素启动浏览器原生拖拽（图片 / 文本 / 链接）。
   * 原生拖拽会抢走指针，使 React Flow 的框选无法启动；早期「左键拖空白」走 d3-zoom、
   * 由它的 dragDisable 顺带兜底，改为「左键框选」后 d3-zoom 不再介入、这层保护消失，
   * 因此需要自己补回来。项目自定义的参考图排序拖拽（REF_DRAG_TYPES）要放行。
   */
  const handleDragStart = useCallback((e: DragEvent) => {
    if (shouldIgnore?.(e.target as HTMLElement)) return;
    if (isRefDrag(e.dataTransfer)) return;
    e.preventDefault();
  }, [shouldIgnore]);

  return { handleDragOver, handleDragStart, handleDrop, isFileDragging };
}
