/**
 * 视口动作 hook：初始视口、受控视口同步、重置视图、整理画布，
 * 以及中键平移的光标接管。
 *
 * 整理仍走 applyTidyLayout 单一编排（Agent 桥共用）；本 hook 只负责把
 * React Flow 的视口读写与画布菜单动作接起来。
 */
"use client";

import { useCallback, useEffect, useMemo } from "react";

import { applyTidyLayout } from "@/features/canvas/hooks/use-tidy-animation";
import { isGroupNode, memberParentId } from "@/features/canvas/shared/group-membership";
import { syncLiveViewport, useCanvasStore } from "@/features/canvas/stores/canvas-store";

export interface UseCanvasViewportActionsOptions {
  root: React.RefObject<HTMLDivElement | null>;
  setViewport: (viewport: { x: number; y: number; zoom: number }, options?: { duration?: number }) => void;
  fitView: (options?: { duration?: number }) => void;
}

export function useCanvasViewportActions({
  root,
  setViewport,
  fitView,
}: UseCanvasViewportActionsOptions) {
  // 冻结 defaultViewport 引用——React Flow 仅在首次挂载时读取此值，
  // 后续 viewport 变更走 store + setViewport，绝不能让此 prop 随渲染更新，
  // 否则会触发 onViewportChange -> setViewport -> 重渲染 -> defaultViewport 变 -> ∞
  const defaultViewport = useMemo(() => useCanvasStore.getState().viewport, []);
  const nodes = useCanvasStore((s) => s.nodes);

  // 画布内容的唯一恢复入口是会话握手（session/session-events 在 SSE 首帧后 restore）：
  // 页面不 GET 单项目，画布仅在 loader 门开启（恢复已完成）后挂载，此处不再重复恢复。
  // React Flow 内部视口跟随 restoreFromProject：订阅应用次数信号。
  // 恢复出的视口与 _liveViewport 一致，syncLiveViewport 的同值守卫不会误标脏。
  const viewportSyncCount = useCanvasStore((s) => s.viewportSyncCount);
  useEffect(() => {
    setViewport(useCanvasStore.getState().viewport, { duration: 0 });
  }, [viewportSyncCount, setViewport]);

  const handleViewportChange = useCallback(
    (vp: { x: number; y: number; zoom: number }) => {
      syncLiveViewport({ x: vp.x, y: vp.y, zoom: vp.zoom });
    },
    [],
  );

  const handleResetView = useCallback(() => {
    const s = useCanvasStore.getState();
    s.resetViewport();
    fitView({ duration: 300 });
  }, [fitView]);

  /**
   * 整理画布：编排单源在 applyTidyLayout（与 Agent 桥共用）。
   * 排序依据自动选择 —— 有连线走拓扑序（上游在前），否则走读序。
   */
  const handleTidyCanvas = useCallback(() => {
    applyTidyLayout({ fitView });
  }, [fitView]);

  // 整理需要至少 2 个顶层块（组连同成员算一个块），否则菜单置灰
  const tidyDisabled = useMemo(() => {
    // parentId 是唯一结构关系：成员（有 parentId 且父存在）不算顶层块
    const groupIds = new Set(nodes.filter(isGroupNode).map((n) => n.id));
    const topLevel = nodes.filter((n) => {
      const parentId = memberParentId(n);
      return parentId === undefined || !groupIds.has(parentId);
    });
    return topLevel.length < 2;
  }, [nodes]);

  // 中键拖拽同样能平移，但 React Flow 的 .draggable 只在 panOnDrag 含左键 0 时挂载，
  // 中键按下不会自动变抓手。这里手动补光标，与按住空格的手感保持一致。
  useEffect(() => {
    const el = root.current;
    if (!el) return;

    const onDown = (e: MouseEvent) => {
      // 只在中键、且确实按在画布内时才切换光标
      if (e.button !== 1 || !el.contains(e.target as Node)) return;
      // d3-zoom 接管中键平移时没有 preventDefault，Windows/Chrome 会弹出中键自动滚动，
      // 它的原生光标会盖住 CSS 抓手。这里在捕获阶段拦掉默认行为（不影响平移本身）。
      e.preventDefault();
      el.classList.add("middle-panning");
    };
    // 中键若在窗口外松开，mouseup 不会派发到 window，靠 blur 兜底复位
    const onUp = () => el.classList.remove("middle-panning");

    // 必须用捕获阶段：中键平移被 React Flow 底层的 d3-zoom 接管后，d3-zoom 会在目标元素上
    // stopImmediatePropagation()，冒泡阶段挂到 window 的监听收不到该事件。
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("blur", onUp);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("blur", onUp);
      el.classList.remove("middle-panning");
    };
  }, [root]);

  return {
    defaultViewport,
    handleViewportChange,
    handleResetView,
    handleTidyCanvas,
    tidyDisabled,
  };
}
