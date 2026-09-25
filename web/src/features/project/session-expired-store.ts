/**
 * 会话过期状态。
 * 同页写通道已由 saveMutex 串行化，画布保存收到 409 即意味着画布已在
 * 其他标签页 / 浏览器被修改——本窗口对该画布过期，停用保存并引导刷新。
 * SaveManager 负责触发；过期属于「画布内容」而非整个窗口，
 * 切换 / 重载画布内容（restoreFromProject）时由 SaveManager 重置。
 */
import { create } from "zustand";

interface SessionExpiredState {
  expired: boolean;
  markExpired: () => void;
  resetExpired: () => void;
}

export const useSessionExpiredStore = create<SessionExpiredState>((set) => ({
  expired: false,
  markExpired: () => set({ expired: true }),
  resetExpired: () => set({ expired: false }),
}));
