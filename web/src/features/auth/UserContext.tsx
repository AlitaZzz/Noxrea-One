"use client";

import { createContext, type ReactNode, useContext } from "react";

import { useAuthStore } from "@/features/auth/store";
import type { UserInfo } from "@/features/auth/user-cache";

/**
 * 服务端直出的用户缓存：根布局解析 noxrea-user cookie 后经 props 注入，
 * SSR 与客户端水合首帧都能渲染真实头像/用户名（store 此刻尚未初始化）。
 * store 的 /me 结果就绪后优先取 store（fresh 值）。
 */
const CachedUserContext = createContext<UserInfo | null>(null);

export function CachedUserProvider({ user, children }: { user: UserInfo | null; children: ReactNode }) {
  return <CachedUserContext.Provider value={user}>{children}</CachedUserContext.Provider>;
}

/** 当前用户：store（/me 校正后）优先，否则回退到 SSR 注入的 cookie 缓存 */
export function useCurrentUser(): UserInfo | null {
  const storeUser = useAuthStore((s) => s.user);
  const cachedUser = useContext(CachedUserContext);
  return storeUser ?? cachedUser;
}
