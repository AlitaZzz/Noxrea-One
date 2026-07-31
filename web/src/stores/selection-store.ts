import { create } from "zustand";

import type { AnyNode,ClipboardData } from "@/lib/types";

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
