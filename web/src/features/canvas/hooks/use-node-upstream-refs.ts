"use client";

import { useStoreWithEqualityFn } from "zustand/traditional";

import {
  buildUpstreamRefs,
  type NodeUpstreamRefs,
  sameUpstreamRefs,
} from "@/features/canvas/shared/upstream-refs";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

/** 面板隐藏时的投影：常量引用，结构比较直接命中，不扫描画布。 */
const EMPTY_REFS: NodeUpstreamRefs = { images: [], texts: [], audios: [], videos: [] };

/**
 * 生成面板的上游引用订阅（三面板共用）。
 *
 * 选择器每次 store 变更都会重算引用投影，但以结构比较 bail：拖动只改节点
 * position，投影结果按值不变，面板不重渲染。这样订阅依赖的是「内容」而不是
 * 「nodes 数组引用」，也不需要任何全局缓存来伪造引用稳定。
 *
 * 面板宿主常驻后，隐藏面板必须停止这次全画布投影：`active=false` 时选择器
 * 退化为常量，store 任何变更都不再进入 buildUpstreamRefs，也不触发所在面板
 * 重渲染。隐藏面板不显示、不接受输入，投影值无需保真；重新可见时选择器
 * 恢复实时投影，面板按真实引用重新渲染。
 */
export function useNodeUpstreamRefs(nodeId: string, active: boolean): NodeUpstreamRefs {
  return useStoreWithEqualityFn(
    useCanvasStore,
    (s) => (active ? buildUpstreamRefs(s.nodes, s.edges, nodeId) : EMPTY_REFS),
    sameUpstreamRefs,
  );
}
