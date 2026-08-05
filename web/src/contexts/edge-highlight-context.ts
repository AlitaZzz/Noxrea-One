"use client";

import { createContext, useContext } from "react";

/** 当前选中节点关联的所有边 ID 集合 */
export const EdgeHighlightContext = createContext<Set<string>>(new Set());

export function useHighlightedEdges(): Set<string> {
  return useContext(EdgeHighlightContext);
}
