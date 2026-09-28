/**
 * 画布剪贴板状态仓库：暂存复制的节点与内部连线供粘贴使用。
 */
import { create } from "zustand";

import type { AnyEdge, AnyNode } from "@/features/canvas/types";
import type { ClipboardData } from "@/features/project/types";

interface SelectionState {
  clipboard: ClipboardData | null;
  copySelected: (selectedNodes: AnyNode[], innerEdges?: AnyEdge[]) => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  clipboard: null,

  copySelected: (selectedNodes, innerEdges = []) => {
    set({
      clipboard: {
        nodes: selectedNodes.map((n) => ({ ...n, selected: false })),
        edges: innerEdges.map((e) => ({ ...e, selected: false })),
      },
    });
  },

}));
