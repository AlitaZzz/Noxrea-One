/**
 * 登录鉴权状态仓库。
 * 保存当前用户信息与登录态，提供初始化（恢复会话）、登录、注册、登出、
 * 角色判定与主题 / 语言偏好持久化。
 */
import { create } from "zustand";

import { authApi } from "@/features/auth/api";
import { ApiError, UnauthorizedError } from "@/lib/api/client";
import { resolveApiError } from "@/lib/api/error-message";
import { showGlobalNotification } from "@/lib/global-notification";
import { setAppLanguage } from "@/lib/i18n/config";
import { captureSession, changeSession, onSessionChange, SessionChangedError } from "@/lib/session-lifecycle";

import { parseUserCookie, toUserInfo, USER_COOKIE, type UserInfo } from "./user-cache";

// 用户信息缓存在非 httpOnly cookie（stale-while-revalidate）：刷新后首帧
// 服务端即可直出真实头像/用户名（根布局解析同一 cookie 注入），/me 在后台校正。
// localStorage 服务端读不到，会导致「占位 → 填充」闪变，故弃用。

function readCachedUser(): UserInfo | null {
  if (typeof document === "undefined") return null;
  try {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${USER_COOKIE}=([^;]*)`));
    return parseUserCookie(match?.[1]);
  } catch {
    return null;
  }
}

function cacheUser(user: UserInfo | null) {
  if (typeof document === "undefined") return;
  if (user) {
    document.cookie = `${USER_COOKIE}=${encodeURIComponent(JSON.stringify(user))}; path=/; max-age=31536000; samesite=lax`;
  } else {
    document.cookie = `${USER_COOKIE}=; path=/; max-age=0; samesite=lax`;
  }
}

/** 登出清凭据的最大等待时长：超过即放行导航，避免网络挂起时卡在当前页 */
const LOGOUT_CLEAR_TIMEOUT_MS = 3000;

/**
 * initialize 的在途 promise：并发调用（StrictMode 双挂载）共享同一次 /me。
 * 会话变化时解除在途引用，旧请求不能更新新会话。
 */
let authInitInFlight: Promise<void> | null = null;

interface AuthState {
  user: UserInfo | null;
  loading: boolean;
  initialized: boolean;

  initialize: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  savePreference: (key: "theme" | "language", value: string) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: readCachedUser(),
  loading: false,
  initialized: false,

  initialize: () => {
    if (get().initialized) return Promise.resolve();
    if (authInitInFlight) return authInitInFlight;
    const session = captureSession();
    const pending = (async () => {
      set({ loading: true });
      try {
        // api() 对空/无法解析的响应体返回 null：视为无登录用户，与其余入口一样先判空再转换
        const me = await session.run(() => authApi.me<UserInfo | null>());
        session.assertCurrent();
        set({ user: me ? toUserInfo(me) : null, loading: false, initialized: true });
      } catch (e) {
        if (session.signal.aborted) return;
        set({ ...(e instanceof UnauthorizedError ? { user: null } : {}), loading: false, initialized: true });
      }
    })().finally(() => {
      if (authInitInFlight === pending) authInitInFlight = null;
    });
    authInitInFlight = pending;
    return pending;
  },

  login: async (rawUsername, rawPassword) => {
    const session = captureSession();
    const username = rawUsername.trim().toLowerCase();
    // 密码不做 trim：空格是合法密码字符，静默裁剪会让「注册时按裁剪值存储、
    // 登录时按原值提交」产生不一致
    // 凭据由服务端登录接口 Set-Cookie 下发（httpOnly），前端不再保存 token
    let data: { user: UserInfo };
    try {
      data = await session.run(() => authApi.login<{ user: UserInfo }>(username, rawPassword));
      session.assertCurrent();
    } catch (e) {
      if (e instanceof SessionChangedError) throw e;
      throw new Error(
        e instanceof ApiError ? e.message : resolveApiError(null, undefined, "auth.login_failed")
      );
    }
    if (data?.user) {
      set({ user: toUserInfo(data.user), loading: false, initialized: true });
    } else {
      throw new Error(resolveApiError(null, undefined, "auth.login_failed"));
    }
  },

  register: async (rawUsername, rawPassword) => {
    const session = captureSession();
    const username = rawUsername.trim().toLowerCase();
    // 同 login：密码不裁剪
    let data: { user: UserInfo };
    try {
      data = await session.run(() => authApi.register<{ user: UserInfo }>(username, rawPassword));
      session.assertCurrent();
    } catch (e) {
      if (e instanceof SessionChangedError) throw e;
      throw new Error(
        e instanceof ApiError ? e.message : resolveApiError(null, undefined, "auth.register_failed")
      );
    }
    if (data?.user) {
      set({ user: toUserInfo(data.user), loading: false, initialized: true });
    } else {
      throw new Error(resolveApiError(null, undefined, "auth.register_failed"));
    }
  },

  logout: () => {
    // 服务端过期 httpOnly cookie（JS 无法清除）；本地同步清用户态与缓存。
    // 返回 promise 供调用方等待：cookie 未清除前导航，proxy.ts 会按 cookie 有效性放行/拦截。
    if (!get().user) changeSession();
    set({ user: null, loading: false, initialized: true });
    const done = authApi.logout();
    // 请求挂起时超时放行；登出失败（网络错误等）不影响本地清态，静默吞掉
    let timeout: ReturnType<typeof setTimeout>;
    return Promise.race([
      done.catch(() => undefined),
      new Promise<void>((resolve) => { timeout = setTimeout(resolve, LOGOUT_CLEAR_TIMEOUT_MS); }),
    ]).then(() => undefined).finally(() => clearTimeout(timeout));
  },

  savePreference: async (key, value) => {
    const session = captureSession();
    const user = get().user;
    if (!user) return;
    const prev = user[key];
    // 语言切换唯一入口：i18n 与 localStorage/cookie 由 setAppLanguage 统一处理，
    // 保存失败时一并回滚，避免「账号偏好已回退、界面语言仍是新值」的分叉
    if (key === "language") setAppLanguage(value === "en" ? "en" : "zh");
    set({ user: { ...user, [key]: value } });
    try {
      // 前端用 avatarUrl / language，后端 updateMeSchema 也接受这些字段
      // 校验结果：此前无论成败都保留本地值，刷新后偏好会静默回退
      await session.run(() => authApi.updateMe({ [key]: value }));
      session.assertCurrent();
    } catch (e) {
      if (session.signal.aborted) return;
      // 仅当失败的是最新一次修改时才回滚：并发保存（如双击切换）后，
      // 旧请求迟到失败不能覆盖新值
      const cur = get().user;
      if (cur && cur[key] === value) {
        set({ user: { ...cur, [key]: prev } });
        if (key === "language") setAppLanguage(prev === "en" ? "en" : "zh");
      }
      showGlobalNotification().error({
        title: e instanceof ApiError ? e.message : resolveApiError(null, undefined, "auth.preference_failed"),
        placement: "bottomRight",
        duration: 6,
      });
    }
  },
}));

// user 的任何变化（登录 / 偏好更新 / 回滚 / 登出）统一落盘缓存
useAuthStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) changeSession();
  cacheUser(state.user);
});
onSessionChange(() => { authInitInFlight = null; });
