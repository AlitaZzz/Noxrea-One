// 用户信息缓存（stale-while-revalidate）的 cookie 载体。
// 独立成共享模块（无 "use client"、不依赖 store/i18n）：
// 服务端根布局导入它解析 cookie 实现 SSR 直出真实用户，
// 浏览器端 auth store 导入它做读写——两端同一来源，头像/用户名不再占位闪变。
export const USER_COOKIE = "noxrea-user";

export interface UserInfo {
  id: number;
  username: string;
  role: string;
  avatarUrl: string | null;
  theme: string;
  language: string;
}

/** 解析并校验 cookie 中的用户信息，结构不对返回 null */
export function parseUserCookie(raw: string | undefined): UserInfo | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as UserInfo;
    if (typeof parsed?.id !== "number" || typeof parsed?.username !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
