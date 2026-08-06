/**
 * 画布剪贴板状态仓库：暂存复制的节点供粘贴使用。
 */
import { create } from "zustand";

import type { AnyNode } from "@/features/canvas/types";
import type { ClipboardData } from "@/features/project/types";

interface SelectionState {
  clipboard: ClipboardData | null;
  copySelected: (selectedNodes: AnyNode[]) => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  clipboard: null,

  copySelected: (selectedNodes) => {
    set({
      clipboard: {
        nodes: selectedNodes.map((n) => ({ ...n, selected: false })),
        edges: [],
      },
    });
  },

}));
