import { create } from "zustand";
import type { HistorySnapshot } from "@/lib/types";
import { HISTORY_MAX_SIZE } from "@/lib/constants";

interface HistoryState {
  undoStack: HistorySnapshot[];
  redoStack: HistorySnapshot[];

  /** Push current state before making a change */
  push: (snapshot: HistorySnapshot) => void;
  /**
   * 弹出并返回 undoStack 栈顶（= 最近一次改动前的状态，即撤销要恢复的目标）。
   * `current` 必须是调用瞬间的现场快照，会被存入 redoStack —— redo 用它回到撤销前的状态。
   * 无可撤销时返回 null 且不改动任何栈。
   */
  undo: (current: HistorySnapshot) => HistorySnapshot | null;
  /**
   * 弹出并返回 redoStack 栈顶（= 上一次撤销前的现场状态）。
   * `current` 是调用瞬间的现场快照，会被存回 undoStack，保证 redo 之后还能再 undo 回来。
   * 无可重做时返回 null 且不改动任何栈。
   */
  redo: (current: HistorySnapshot) => HistorySnapshot | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clear: () => void;
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

  undo: (current) => {
    const { undoStack } = get();
    if (undoStack.length === 0) return null;
    const target = undoStack[undoStack.length - 1];
    set((s) => ({
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, current],
    }));
    return target;
  },

  redo: (current) => {
    const { redoStack } = get();
    if (redoStack.length === 0) return null;
    const target = redoStack[redoStack.length - 1];
    set((s) => ({
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, current],
    }));
    return target;
  },

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,
  clear: () => set({ undoStack: [], redoStack: [] }),
}));
