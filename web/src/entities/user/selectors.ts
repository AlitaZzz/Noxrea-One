/**
 * 当前用户领域读取接口。
 * 只暴露渲染所需的薄选择器；store 与内部状态形状不对外。
 */
import { useUserStore } from "./store";
import type { StorageSummary, UserInfo } from "./types";

/** 仅会话 store 中的当前用户；用于「是否已登录」一类副作用，不含 SSR 缓存。 */
export function useSessionUser(): UserInfo | null {
  return useUserStore((state) => state.user);
}

/** 当前用户的存储摘要；未获取到 /me 时为 null。 */
export function useUserStorage(): StorageSummary | null {
  return useUserStore((state) => state.storage);
}
