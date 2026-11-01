/**
 * 节点选中状态的独立订阅口。
 *
 * 节点主体不再因 `selected` prop 重渲染（见 shared/memo-canvas-node.ts）：需要
 * 随选中变化的 UI（缩放手柄、面板可用性）与行为（取消选中暂停播放）在这里订阅，
 * 只让订阅者承担选中变化的渲染/副作用成本。
 */
import { useEffect, useRef } from "react";

import { getCanvasDerived } from "@/features/canvas/shared/canvas-derived";
import { type CanvasState, useCanvasStore } from "@/features/canvas/stores/canvas-store";

function readSelected(state: CanvasState, nodeId: string): boolean {
  return getCanvasDerived(state.nodes, state.edges).selectedNodeIds.has(nodeId);
}

/** 当前节点的选中态（只有布尔值变化才触发重渲染） */
export function useNodeSelected(nodeId: string): boolean {
  return useCanvasStore((state) => readSelected(state, nodeId));
}

/** 是否处于多选（≥2 个节点选中）：与选中外框、批量连线入口同一判定 */
export function useMultiSelect(): boolean {
  return useCanvasStore((state) => getCanvasDerived(state.nodes, state.edges).selectedNodeIds.size > 1);
}

/**
 * 订阅单个节点的选中态变化（不重渲染节点主体）。
 * 只在状态真正翻转时回调；挂载时的初始值不回调，调用方需要的挂载行为自行处理。
 */
export function useNodeSelectionChange(
  nodeId: string,
  onChange: (selected: boolean) => void,
): void {
  const callbackRef = useRef(onChange);
  useEffect(() => {
    callbackRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    let previous = readSelected(useCanvasStore.getState(), nodeId);
    return useCanvasStore.subscribe((state) => {
      const next = readSelected(state, nodeId);
      if (next === previous) return;
      previous = next;
      callbackRef.current(next);
    });
  }, [nodeId]);
}
