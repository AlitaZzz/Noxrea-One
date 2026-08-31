/**
 * 画布交互状态机。
 *
 * 把「画布当前处于哪种交互」建模为一组互斥状态，取代此前用多个独立布尔量
 * （框选抑制 / 拖动中 / 拖线中）拼凑的写法。布尔量拼凑的问题在于：组合状态
 * （如「框选之后又拖动节点」）没有对应语义，只能靠事后补条件修正。
 *
 * 建模之后：
 * - 状态互斥，不存在未定义组合；
 * - 与交互相关的 UI 可见性（handle、节点工具栏、生成面板、光标）全部从状态派生；
 * - 新增交互只需增加一个 mode，不必到处补 if。
 */
"use client";

import { useCallback, useMemo, useReducer } from "react";

/** 非瞬时交互状态：空闲/点击选中、框选选中。拖动中会记住进入前的状态 */
type StableInteractionMode = "idle" | "box-selecting";

/** 画布交互状态（互斥） */
export type CanvasInteraction =
  /** 空闲或点击选中：正常显示选中态 UI（工具栏 / 生成面板 / 选中 handle） */
  | { mode: "idle" }
  /** 框选（Shift 拖拽）产生的选中：只做高亮，不显示选中态 UI，直到下次点击 */
  | { mode: "box-selecting" }
  /** 拖动节点中：隐藏 handle / 工具栏 / 生成面板，避免跟随节点飘动；prev 用于松手后恢复 */
  | { mode: "dragging-nodes"; prev: StableInteractionMode }
  /** 拖拽连线中：画布保持十字准星光标 */
  | { mode: "connecting" };

type InteractionAction =
  | { type: "selection-start" }
  | { type: "click" }
  | { type: "node-drag-start" }
  | { type: "node-drag-stop" }
  | { type: "connect-start" }
  | { type: "connect-end" };

function interactionReducer(state: CanvasInteraction, action: InteractionAction): CanvasInteraction {
  switch (action.type) {
    case "selection-start":
      return state.mode === "box-selecting" ? state : { mode: "box-selecting" };

    // 单击节点或点击空白：视为「点击选中」，恢复正常显示
    case "click":
      return state.mode === "idle" ? state : { mode: "idle" };

    // 记录进入拖动前的状态，松手后原样恢复：
    // 框选一批节点后再拖动，松手仍属于批量选中态；单击选中后拖动则恢复空闲态
    case "node-drag-start": {
      if (state.mode === "dragging-nodes") return state;
      const prev: StableInteractionMode = state.mode === "box-selecting" ? "box-selecting" : "idle";
      return { mode: "dragging-nodes", prev };
    }

    case "node-drag-stop":
      return state.mode === "dragging-nodes" ? { mode: state.prev } : state;

    case "connect-start":
      return state.mode === "connecting" ? state : { mode: "connecting" };

    case "connect-end":
      return state.mode === "connecting" ? { mode: "idle" } : state;

    default:
      return state;
  }
}

/**
 * 提供画布交互状态及事件派发。
 * showSelectionChrome 为唯一的可见性真相源，调用方不应再自行组合条件。
 */
export function useCanvasInteraction() {
  const [interaction, dispatch] = useReducer(interactionReducer, { mode: "idle" } as CanvasInteraction);

  const onSelectionStart = useCallback(() => dispatch({ type: "selection-start" }), []);
  const onClick = useCallback(() => dispatch({ type: "click" }), []);
  const onNodeDragStart = useCallback(() => dispatch({ type: "node-drag-start" }), []);
  const onNodeDragStop = useCallback(() => dispatch({ type: "node-drag-stop" }), []);
  const onConnectStart = useCallback(() => dispatch({ type: "connect-start" }), []);
  const onConnectEnd = useCallback(() => dispatch({ type: "connect-end" }), []);

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
