/**
 * 当前用户领域命令。
 * 组件不直接触达 store：命令是唯一的写入口。
 */
import { useUserStore } from "./store";
import type { ProfilePatch, UserInfo } from "./types";

/**
 * 恢复会话（/me）。并发调用共享同一次请求；返回初始化完成后的当前用户，
 * 未登录或初始化失败返回 null。
 */
export async function initializeSession(): Promise<UserInfo | null> {
  await useUserStore.getState().initialize();
  return useUserStore.getState().user;
}

/** 拉取最新存储摘要（设置弹窗打开时调用）；失败保留现值。 */
export function refreshStorage(): Promise<void> {
  return useUserStore.getState().refreshStorage();
}

export function login(username: string, password: string): Promise<void> {
  return useUserStore.getState().login(username, password);
}

export function register(username: string, password: string): Promise<void> {
  return useUserStore.getState().register(username, password);
}

/** 本地同步清态并向服务端注销；请求挂起时超时放行。 */
export function logout(): Promise<void> {
  return useUserStore.getState().logout();
}

/** 保存账号偏好（主题 / 语言）：乐观更新，失败回滚并提示。 */
export function savePreference(key: "theme" | "language", value: string): Promise<void> {
  return useUserStore.getState().savePreference(key, value);
}

/**
 * 更新账户资料（头像 / 密码）。
 * 返回更新后的用户；服务端空响应返回 null；请求失败抛出错误由调用方提示。
 */
export function updateProfile(patch: ProfilePatch): Promise<UserInfo | null> {
  return useUserStore.getState().updateProfile(patch);
}
