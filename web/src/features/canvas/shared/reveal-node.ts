/**
 * 参考区「双击素材 → 画布定位对应节点」的工具集。
 *
 * - useRevealCanvasNode：拿到 React Flow 的 setCenter，把某节点居中定位。
 *   尺寸回退与 CanvasExplorer 一致（节点实测宽高，缺省 200）。
 * - findReferenceNode：按「目标生成节点 + 参考类型 + src」反查画布上游参考节点。
 *   参考列表持久化的是 src，可能对应多个节点（复制/同源），这里限定为连到当前
 *   target 的上游节点，保证定位的是真正喂给该节点的那个参考。
 */
"use client";

import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";

import { useCenterNode } from "./center-node";

/** 拿到「居中定位节点」的方法（须在 ReactFlowProvider 内使用） */
export const useRevealCanvasNode = useCenterNode;

/** 反查 target 节点在画布上的上游参考节点（按类型与 src 匹配） */
export function findReferenceNode(
  targetNodeId: string,
  type: string,
  src: string,
): AnyNode | undefined {
  const { nodes, edges } = useCanvasStore.getState();
  const upstreamIds = new Set(edges.filter((e) => e.target === targetNodeId).map((e) => e.source));
  return nodes.find(
    (n) =>
      n.type === type &&
      upstreamIds.has(n.id) &&
      (n.data as { src?: string }).src === src,
  );
}