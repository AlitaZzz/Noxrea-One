"use client";

import { useStoreWithEqualityFn } from "zustand/traditional";

import {
  buildUpstreamRefs,
  type NodeUpstreamRefs,
  sameUpstreamRefs,
} from "@/features/canvas/shared/upstream-refs";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

/**
 * 生成面板的上游引用订阅（三面板共用）。
 *
 * 选择器每次 store 变更都会重算引用投影，但以结构比较 bail：拖动只改节点
 * position，投影结果按值不变，面板不重渲染。这样订阅依赖的是「内容」而不是
 * 「nodes 数组引用」，也不需要任何全局缓存来伪造引用稳定。
 */
export function useNodeUpstreamRefs(nodeId: string): NodeUpstreamRefs {
  return useStoreWithEqualityFn(
    useCanvasStore,
    (s) => buildUpstreamRefs(s.nodes, s.edges, nodeId),
    sameUpstreamRefs,
  );
}
