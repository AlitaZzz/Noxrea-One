"use client";

import { createContext, type ReactNode, useContext } from "react";

import { useUserStore } from "./store";
import type { UserInfo } from "./types";

/**
 * 服务端直出的用户缓存：根布局解析 noxrea-user cookie 后经 props 注入，
 * SSR 与客户端水合首帧都能渲染真实头像/用户名（store 此刻尚未初始化）。
 * store 的 /me 结果就绪后优先取 store（fresh 值）。
 */
const CachedUserContext = createContext<UserInfo | null>(null);

export function CachedUserProvider({ user, children }: { user: UserInfo | null; children: ReactNode }) {
  return <CachedUserContext.Provider value={user}>{children}</CachedUserContext.Provider>;
}

/** SSR 缓存仅用于首次恢复前；恢复或登出后 store 的 null 也是权威值。 */
export function useCurrentUser(): UserInfo | null {
  const storeUser = useUserStore((s) => s.user);
  const initialized = useUserStore((s) => s.initialized);
  const cachedUser = useContext(CachedUserContext);
  return initialized ? storeUser : storeUser ?? cachedUser;
}
