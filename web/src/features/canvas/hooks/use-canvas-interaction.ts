/**
 * 画布交互状态机 hook（薄包装）。
 *
 * 状态唯一真相源在 canvas-store 的瞬态字段 interaction（不落库、不进撤销历史）：
 * 节点组件（如 VideoNode 在连线 / 拖动期间抑制 hover 预览）也能读取同一状态。
 * 本 hook 只是把 store 状态与派发动作包装成记忆化 API，调用方（CanvasSurface）
 * 无感知迁移。
 *
 * 建模收益：状态互斥，不存在未定义组合；与交互相关的 UI 可见性
 * （handle、节点工具栏、生成面板、光标）全部从状态派生；
 * 新增交互只需增加一个 mode，不必到处补 if。
 */
"use client";

import { useCallback, useMemo } from "react";

import type { CanvasInteraction } from "@/features/canvas/stores/canvas-store";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

/**
 * 画布根的光标门控属性。
 *
 * `data-interaction` 描述当前交互状态；`data-connecting` 只在拖线期间存在，
 * 供全后代光标规则门控——若直接复用 `data-interaction="connecting"`，选中态
 * 切换（idle ↔ box-selected）也会改变根属性，使整棵画布子树重算光标样式。
 */
export function canvasRootInteractionAttrs(mode: CanvasInteraction["mode"]) {
  return {
    "data-interaction": mode,
    "data-connecting": mode === "connecting" ? ("true" as const) : undefined,
  };
}

/**
 * 提供画布交互状态及事件派发。
 * 可见性只从这里派生的两个谓词取值，调用方不应再自行组合 mode 条件：
 * - showSelectionToolbars：节点工具栏（per-node / 聚合），框选提交后恢复；
 * - showSelectionChrome：生成面板等重装饰，仅点击选中（idle）时显示。
 */
export function useCanvasInteraction() {
  const interaction = useCanvasStore((s) => s.interaction);
  const dispatch = useCanvasStore((s) => s.dispatchInteraction);

  const onClick = useCallback(() => dispatch({ type: "click" }), [dispatch]);
  const onNodeDragStart = useCallback(() => dispatch({ type: "node-drag-start" }), [dispatch]);
  const onNodeDragStop = useCallback(() => dispatch({ type: "node-drag-stop" }), [dispatch]);
  const onConnectStart = useCallback(() => dispatch({ type: "connect-start" }), [dispatch]);
  const onConnectEnd = useCallback(() => dispatch({ type: "connect-end" }), [dispatch]);

  /**
   * 生成面板等重装饰是否显示：仅点击选中（idle）为 true。
   * 框选提交后仍按框选语义让位，避免松手瞬间弹出生成面板。
   */
  const showSelectionChrome = interaction.mode === "idle";

  /**
   * 节点工具栏（per-node / 聚合）是否显示。
   * 框选手势进行中让位，提交后（box-selected）立即恢复——聚合工具条必须在
   * 「松手后出现」（spec 7.2）；拖动中隐藏，拖停后按 prev 恢复。
   */
  const showSelectionToolbars =
    interaction.mode === "idle" || interaction.mode === "box-selected";

  // 返回整体做记忆化：调用方直接把返回值放进依赖数组，引用只在 mode 变化时更新，
  // 避免每次渲染都重建下游 useCallback（否则 React Flow 的回调 props 会每帧变化）
  return useMemo(
    () => ({
      mode: interaction.mode,
      showSelectionChrome,
      showSelectionToolbars,
      onClick,
      onNodeDragStart,
      onNodeDragStop,
      onConnectStart,
      onConnectEnd,
    }),
    [
      interaction.mode,
      showSelectionChrome,
      showSelectionToolbars,
      onClick,
      onNodeDragStart,
      onNodeDragStop,
      onConnectStart,
      onConnectEnd,
    ]
  );
}
