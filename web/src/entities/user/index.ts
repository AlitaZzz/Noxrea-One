/**
 * 当前用户领域公共 API。
 *
 * 只暴露身份类型、SSR 用户缓存契约、读取 Hook 与写命令；
 * store、认证 API 与内部实现不对外。
 */

// ── 类型 ──
export type { ProfilePatch, StorageSummary, UserInfo } from "./types";

// ── SSR 契约（Server Component 可用） ──
export { parseUserCookie, USER_COOKIE } from "./user-cookie";

// ── 读取 ──
export { useSessionUser, useUserStorage } from "./selectors";
export { CachedUserProvider, useCurrentUser } from "./UserContext";

// ── 写命令 ──
export {
  initializeSession,
  login,
  logout,
  refreshStorage,
  register,
  savePreference,
  updateProfile,
} from "./commands";
