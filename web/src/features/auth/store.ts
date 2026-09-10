/**
 * 登录鉴权状态仓库。
 * 保存当前用户信息与登录态，提供初始化（恢复会话）、登录、注册、登出、
 * 角色判定与主题 / 语言偏好持久化。
 */
import { create } from "zustand";

import { authApi } from "@/features/auth/api";
import { setToken } from "@/lib/api/client";
import { type ApiErrorBody,resolveApiError, resolveResultError } from "@/lib/api/error-message";
import { showGlobalNotification } from "@/lib/global-notification";
import i18n from "@/lib/i18n/config";

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
    // 密码不做 trim：空格是合法密码字符，静默裁剪会让「注册时按裁剪值存储、
    // 登录时按原值提交」产生不一致
    const res = await authApi.login<{ access_token: string; token_type: string; user: UserInfo }>(username, rawPassword);
    if (res.code === 200 && res.data?.access_token) {
      setToken(res.data.access_token);
      set({ user: res.data.user });
    } else {
      throw new Error(
        resolveApiError(res as unknown as ApiErrorBody, undefined, "auth.login_failed")
      );
    }
  },

  register: async (rawUsername, rawPassword) => {
    const username = rawUsername.trim().toLowerCase();
    // 同 login：密码不裁剪
    const res = await authApi.register<{ access_token: string; token_type: string; user: UserInfo }>(username, rawPassword);
    if (res.code === 200 && res.data.access_token && res.data.user) {
      setToken(res.data.access_token);
      set({ user: res.data.user });
    } else if (res.code === 200) {
      // 兜底：某些实现可能只返回 user，未带 token
      throw new Error(i18n.t("error.auth.register_missing_credentials"));
    } else {
      throw new Error(
        resolveApiError(res as unknown as ApiErrorBody, undefined, "auth.register_failed")
      );
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
    const prev = user[key];
    set({ user: { ...user, [key]: value } });
    try {
      // 前端用 avatarUrl / language，后端 updateMeSchema 也接受这些字段
      const res = await authApi.updateMe({ [key]: value });
      // 校验业务码：此前无论成败都保留本地值，刷新后偏好会静默回退
      if (res.code !== 200) throw new Error(resolveResultError(res, "auth.preference_failed"));
    } catch (e) {
      const cur = get().user;
      if (cur) set({ user: { ...cur, [key]: prev } });
      showGlobalNotification().error({
        title: e instanceof Error ? e.message : resolveResultError(null, "auth.preference_failed"),
        placement: "bottomRight",
        duration: 6,
      });
    }
  },
}));
