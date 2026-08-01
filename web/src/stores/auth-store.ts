import { create } from "zustand";

import { api, setToken } from "@/lib/api";

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
      const res = await api<UserInfo>("/api/auth/me");
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
    const res = await api<{ access_token: string; token_type: string; user: UserInfo }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ username, password }), skipUnauthorized: true }
    );
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
    const res = await api<{ access_token: string; token_type: string; user: UserInfo }>(
      "/api/auth/register",
      { method: "POST", body: JSON.stringify({ username, password }), skipUnauthorized: true }
    );
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
    api("/api/auth/me", { method: "PUT", body: JSON.stringify({ [key]: value }) }).catch(() => {});
  },
}));
