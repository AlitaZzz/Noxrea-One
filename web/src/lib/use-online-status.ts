/**
 * 全局网络在线状态 hook。
 * 监听 window online / offline 事件，供顶部横幅等 UI 响应式感知断网。
 *
 * 非 React 代码的即时判断请使用 lib/utils/upload 的 isOffline()
 * （直接读 navigator.onLine，无订阅开销）。
 */
"use client";

import { useSyncExternalStore } from "react";

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener("online", onStoreChange);
  window.addEventListener("offline", onStoreChange);
  return () => {
    window.removeEventListener("online", onStoreChange);
    window.removeEventListener("offline", onStoreChange);
  };
}

function getSnapshot(): boolean {
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}

function getServerSnapshot(): boolean {
  return true;
}

/** 当前是否在线（响应式，随 online / offline 事件更新） */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
