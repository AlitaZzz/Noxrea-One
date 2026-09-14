/**
 * 会话过期状态。
 * 同页写通道已由 saveMutex 串行化，画布保存收到 409 即意味着画布已在
 * 其他标签页 / 浏览器被修改——本窗口过期，唯一出口是刷新页面。
 * SaveManager 负责触发，画布页挂「会话已过期」弹窗消费。
 */
import { create } from "zustand";

interface SessionExpiredState {
  expired: boolean;
  markExpired: () => void;
}

export const useSessionExpiredStore = create<SessionExpiredState>((set) => ({
  expired: false,
  markExpired: () => set({ expired: true }),
}));
