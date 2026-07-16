import { create } from "zustand";
import type { HistorySnapshot } from "@/lib/types";
import { DEFAULT_VIEWPORT, DEFAULT_BACKGROUND, DEFAULT_THEME } from "@/lib/constants";
import { HISTORY_MAX_SIZE } from "@/lib/constants";

interface HistoryState {
  undoStack: HistorySnapshot[];
  redoStack: HistorySnapshot[];

  /** Push current state before making a change */
  push: (snapshot: HistorySnapshot) => void;
  /** Returns the snapshot to restore, or null if nothing to undo */
  undo: () => HistorySnapshot | null;
  /** Returns the snapshot to restore, or null if nothing to redo */
  redo: () => HistorySnapshot | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clear: () => void;
}

function emptySnapshot(): HistorySnapshot {
  return {
    nodes: [],
    edges: [],
    viewport: DEFAULT_VIEWPORT,
    background: DEFAULT_BACKGROUND,
    theme: DEFAULT_THEME,
    minimapVisible: true,
    snapToGrid: false,
  };
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  undoStack: [],
  redoStack: [],

  push: (snapshot) =>
    set((s) => {
      const newUndo = [...s.undoStack, snapshot];
      if (newUndo.length > HISTORY_MAX_SIZE) newUndo.shift();
      return { undoStack: newUndo, redoStack: [] };
    }),

  undo: () => {
    const { undoStack } = get();
    if (undoStack.length === 0) return null;
    const current = undoStack[undoStack.length - 1];
    const newUndo = undoStack.slice(0, -1);
    set((s) => ({
      undoStack: newUndo,
      redoStack: [...s.redoStack, current],
    }));
    const prev = newUndo.length > 0 ? newUndo[newUndo.length - 1] : emptySnapshot();
    return prev;
  },

  redo: () => {
    const { redoStack } = get();
    if (redoStack.length === 0) return null;
    const entry = redoStack[redoStack.length - 1];
    const newRedo = redoStack.slice(0, -1);
    set((s) => ({
      redoStack: newRedo,
      undoStack: [...s.undoStack, entry],
    }));
    return entry;
  },

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,
  clear: () => set({ undoStack: [], redoStack: [] }),
}));
