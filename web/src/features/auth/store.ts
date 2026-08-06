/**
 * 登录鉴权状态仓库。
 * 保存当前用户信息与登录态，提供初始化（恢复会话）、登录、注册、登出、
 * 角色判定与主题 / 语言偏好持久化。
 */
import { create } from "zustand";

import { setToken } from "@/lib/api/client";
import { authApi } from "@/features/auth/api";

export interface UserInfo {
  id: number;
  username: string;
  role: string;
  avatarUrl: string | null;
  theme: string;
  language: string;
}

interface AuthState {
  user: UserInfo | null;
  loading: boolean;
  initialized: boolean;

  initialize: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  setSession: (token: string, user: UserInfo) => void;
  logout: () => void;
  isAdmin: () => boolean;
  savePreference: (key: "theme" | "language", value: string) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  loading: false,
  initialized: false,

  initialize: async () => {
    if (get().initialized) return;
    set({ loading: true });
    try {
      const res = await authApi.me<UserInfo>();
      if (res.code === 200 && res.data) {
        set({ user: res.data });
      }
    } catch {
      // Not logged in — guest mode
    }
    set({ loading: false, initialized: true });
  },

  login: async (rawUsername, rawPassword) => {
    const username = rawUsername.trim().toLowerCase();
    const password = rawPassword.trim();
    const res = await authApi.login<{ access_token: string; token_type: string; user: UserInfo }>(username, password);
    if (res.code === 200) {
      setToken(res.data.access_token);
      set({ user: res.data.user });
    } else {
      const detail = (res as unknown as { detail?: string }).detail;
      throw new Error(res.msg || detail || "登录失败");
    }
  },

  register: async (rawUsername, rawPassword) => {
    const username = rawUsername.trim().toLowerCase();
    const password = rawPassword.trim();
    const res = await authApi.register<{ access_token: string; token_type: string; user: UserInfo }>(username, password);
    if (res.code === 200 && res.data.access_token && res.data.user) {
      setToken(res.data.access_token);
      set({ user: res.data.user });
    } else if (res.code === 200) {
      // 兜底：某些实现可能只返回 user，未带 token
      throw new Error("注册成功但未返回登录凭证");
    } else {
      const detail = (res as unknown as { detail?: string }).detail;
      throw new Error(res.msg || detail || "注册失败");
    }
  },

  logout: () => {
    setToken(null);
    set({ user: null });
  },

  setSession: (token, user) => {
    setToken(token);
    set({ user });
  },

  isAdmin: () => get().user?.role === "admin",

  savePreference: async (key, value) => {
    const user = get().user;
    if (!user) return;
    set({ user: { ...user, [key]: value } });
    // 前端用 avatarUrl / language，后端 updateMeSchema 也接受这些字段
    authApi.updateMe({ [key]: value }).catch(() => {});
  },
}));
