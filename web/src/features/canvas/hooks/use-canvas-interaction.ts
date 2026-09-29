/**
 * 画布交互状态机 hook（薄包装）。
 *
 * 状态唯一真相源在 canvas-store 的瞬态字段 interaction（不落库、不进撤销历史）：
 * 节点组件（如 VideoNode 在连线 / 拖动期间抑制 hover 预览）也能读取同一状态。
 * 本 hook 只是把 store 状态与派发动作包装成记忆化 API，调用方（InfiniteCanvas）
 * 无感知迁移。
 *
 * 建模收益：状态互斥，不存在未定义组合；与交互相关的 UI 可见性
 * （handle、节点工具栏、生成面板、光标）全部从状态派生；
 * 新增交互只需增加一个 mode，不必到处补 if。
 */
"use client";

import { useCallback, useMemo } from "react";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

/**
 * 提供画布交互状态及事件派发。
 * showSelectionChrome 为唯一的可见性真相源，调用方不应再自行组合条件。
 */
export function useCanvasInteraction() {
  const interaction = useCanvasStore((s) => s.interaction);
  const dispatch = useCanvasStore((s) => s.dispatchInteraction);

  const onSelectionStart = useCallback(() => dispatch({ type: "selection-start" }), [dispatch]);
  const onClick = useCallback(() => dispatch({ type: "click" }), [dispatch]);
  const onNodeDragStart = useCallback(() => dispatch({ type: "node-drag-start" }), [dispatch]);
  const onNodeDragStop = useCallback(() => dispatch({ type: "node-drag-stop" }), [dispatch]);
  const onConnectStart = useCallback(() => dispatch({ type: "connect-start" }), [dispatch]);
  const onConnectEnd = useCallback(() => dispatch({ type: "connect-end" }), [dispatch]);

  /** 选中态装饰（节点工具栏 / 生成面板）是否显示：仅空闲或点击选中时为 true */
  const showSelectionChrome = interaction.mode === "idle";

  // 返回整体做记忆化：调用方直接把返回值放进依赖数组，引用只在 mode 变化时更新，
  // 避免每次渲染都重建下游 useCallback（否则 React Flow 的回调 props 会每帧变化）
  return useMemo(
    () => ({
      mode: interaction.mode,
      showSelectionChrome,
      onSelectionStart,
      onClick,
      onNodeDragStart,
      onNodeDragStop,
      onConnectStart,
      onConnectEnd,
    }),
    [interaction.mode, showSelectionChrome, onSelectionStart, onClick, onNodeDragStart, onNodeDragStop, onConnectStart, onConnectEnd]
  );
}
