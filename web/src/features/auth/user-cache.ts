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
 * 从服务端 user 对象投影出 cookie 契约字段。
 * toPublicUser 会返回 email/role/displayName 等字段，它们不得落入持久 cookie——
 * 写端（store cacheUser）与读端（parseUserCookie，含 SSR 根布局）都经本函数收口，
 * 历史 cookie 中已泄漏的字段在读入时同样被剥离。
 */
export function toUserInfo(user: unknown): UserInfo | null {
  if (typeof user !== "object" || user === null || Array.isArray(user)) return null;
  const u = user as Partial<UserInfo> & Record<string, unknown>;
  if (typeof u.id !== "number" || typeof u.username !== "string") return null;
  return {
    id: u.id,
    username: u.username,
    avatarUrl: typeof u.avatarUrl === "string" ? u.avatarUrl : null,
    theme: typeof u.theme === "string" ? u.theme : "dark",
    language: typeof u.language === "string" ? u.language : "zh",
  };
}

/** 解析并校验 cookie 中的用户信息（经 toUserInfo 白名单投影，历史泄漏字段被剥离），结构不对返回 null */
export function parseUserCookie(raw: string | undefined): UserInfo | null {
  if (!raw) return null;
  try {
    return toUserInfo(JSON.parse(decodeURIComponent(raw)));
  } catch {
    return null;
  }
}
