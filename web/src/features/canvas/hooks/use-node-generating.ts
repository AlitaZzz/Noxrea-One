"use client";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { TaskBinding } from "@/features/canvas/types";
import { isGenerating } from "@/lib/constants";

/**
 * 节点是否处于生成中（布尔原语订阅，三个生成面板共用）。
 * 只有该节点的 taskBinding 状态变化才让面板重渲染；节点不存在时按未生成处理。
 *
 * `active=false`（面板隐藏）时选择器退化为常量，不再随全画布 store 变更扫描
 * 节点；隐藏面板不渲染生成控件，重新可见时恢复实时值。
 */
export function useNodeGenerating(nodeId: string, active: boolean): boolean {
  return useCanvasStore((s) => {
    if (!active) return false;
    const node = s.nodes.find((n) => n.id === nodeId);
    return isGenerating((node?.data as { taskBinding?: TaskBinding } | undefined)?.taskBinding);
  });
}
