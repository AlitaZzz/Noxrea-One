/**
 * 画布右键菜单状态仓库：仅记录弹出坐标与显隐。
 */
import { create } from "zustand";

interface CtxState {
  x: number; y: number; visible: boolean;
  show: (x: number, y: number) => void;
  hide: () => void;
}

/** 右键菜单状态（独立于组件，hooks 和组件均可使用） */
export const useCtxMenu = create<CtxState>((set) => ({
  x: 0, y: 0, visible: false,
  show: (x, y) => set({ x, y, visible: true }),
  hide: () => set({ visible: false }),
}));
