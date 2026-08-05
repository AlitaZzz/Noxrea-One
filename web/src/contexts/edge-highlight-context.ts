/**
 * 连线高亮 Context。
 * 向下传递当前选中节点关联的边 ID 集合，供连线组件自行判断高亮，避免逐层透传。
 */
"use client";

import { createContext, useContext } from "react";

/** 当前选中节点关联的所有边 ID 集合 */
export const EdgeHighlightContext = createContext<Set<string>>(new Set());

export function useHighlightedEdges(): Set<string> {
  return useContext(EdgeHighlightContext);
}
