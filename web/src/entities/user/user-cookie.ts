// 用户信息缓存（stale-while-revalidate）的 cookie 载体。
// 独立成共享模块（无 "use client"、不依赖 store/i18n）：
// 服务端根布局导入它解析 cookie 实现 SSR 直出真实用户，
// 浏览器端 store 导入它做读写——两端同一来源，头像/用户名不再占位闪变。
import type { UserInfo } from "./types";

export const USER_COOKIE = "noxrea-user";

/**
 * 把服务端用户响应收口为 UserInfo 契约字段。
 * 服务端 toPublicUser 还会返回 email/role/displayName 等字段，它们不得进入 store 与持久 cookie；
 * 所有服务端响应进入 store 的入口（/me、登录、注册、设置保存）都经本函数转换。
 */
export function toUserInfo(user: UserInfo): UserInfo {
  return {
    id: user.id,
    username: user.username,
    avatarKey: user.avatarKey,
    theme: user.theme,
    language: user.language,
  };
}

function isUserInfo(value: unknown): value is UserInfo {
  if (typeof value !== "object" || value === null) return false;
  const u = value as Record<string, unknown>;
  return (
    typeof u.id === "number" &&
    typeof u.username === "string" &&
    (u.avatarKey === null || typeof u.avatarKey === "string") &&
    typeof u.theme === "string" &&
    typeof u.language === "string"
  );
}

/** 解析 cookie 中的用户信息：cookie 是不可信输入，字段类型任一不符即视为无缓存（由 /me 校正）。 */
export function parseUserCookie(raw: string | undefined): UserInfo | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    return isUserInfo(parsed) ? toUserInfo(parsed) : null;
  } catch {
    return null;
  }
}

/** 浏览器端读取缓存用户；SSR 阶段返回 null，由根布局直接解析 cookie。 */
export function readCachedUser(): UserInfo | null {
  if (typeof document === "undefined") return null;
  try {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${USER_COOKIE}=([^;]*)`));
    return parseUserCookie(match?.[1]);
  } catch {
    return null;
  }
}

/** 浏览器端写入/清除缓存用户。 */
export function cacheUser(user: UserInfo | null): void {
  if (typeof document === "undefined") return;
  if (user) {
    document.cookie = `${USER_COOKIE}=${encodeURIComponent(JSON.stringify(user))}; path=/; max-age=31536000; samesite=lax`;
  } else {
    document.cookie = `${USER_COOKIE}=; path=/; max-age=0; samesite=lax`;
  }
}
