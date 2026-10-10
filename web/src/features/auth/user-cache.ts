// 用户信息缓存（stale-while-revalidate）的 cookie 载体。
// 独立成共享模块（无 "use client"、不依赖 store/i18n）：
// 服务端根布局导入它解析 cookie 实现 SSR 直出真实用户，
// 浏览器端 auth store 导入它做读写——两端同一来源，头像/用户名不再占位闪变。
export const USER_COOKIE = "noxrea-user";

export interface UserInfo {
  id: number;
  username: string;
  avatarUrl: string | null;
  theme: string;
  language: string;
}

/**
 * 把服务端用户响应收口为 UserInfo 契约字段。
 * 服务端 toPublicUser 还会返回 email/role/displayName 等字段，它们不得进入 store 与持久 cookie；
 * 所有服务端响应进入 store 的入口（/me、登录、注册、设置保存）都经本函数转换。
 */
export function toUserInfo(user: UserInfo): UserInfo {
  return {
    id: user.id,
    username: user.username,
    avatarUrl: user.avatarUrl,
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
    (u.avatarUrl === null || typeof u.avatarUrl === "string") &&
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
