/**
 * 撤销 / 重做历史仓库。
 * 以双栈保存画布快照，限制最大深度，只负责栈的进出，不感知画布内部结构。
 */
import { create } from "zustand";

import type { HistorySnapshot } from "@/features/project/types";
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
  /**
   * 仅当 snapshot 仍位于 undoStack 栈顶时弹出，返回是否真的弹出了。
   * 用于「补偿式回滚」场景（如生成失败 / 取消时撤销刚压入的预生成快照）：
   * 期间若已有其他操作入栈，snapshot 不再是栈顶，此时放弃弹出，
   * 避免误删无关快照导致撤销行为错乱。
   */
  popIfTop: (snapshot: HistorySnapshot) => boolean;
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

  popIfTop: (snapshot) => {
    const { undoStack } = get();
    if (undoStack.length === 0 || undoStack[undoStack.length - 1] !== snapshot) return false;
    set((s) => ({ undoStack: s.undoStack.slice(0, -1) }));
    return true;
  },

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,
  clear: () => set({ undoStack: [], redoStack: [] }),
}));
