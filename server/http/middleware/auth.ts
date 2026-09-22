/**
 * 请求鉴权中间件。
 * 解析访问令牌、构造鉴权用户对象。JWT 签发/校验与密码哈希等纯逻辑在 core/auth。
 *
 * 浏览器端 token 存于 httpOnly cookie（由登录/注册接口 Set-Cookie 下发，
 * JS 不可读，XSS 无法窃取）；纯 API 客户端仍可走 Authorization: Bearer。
 */
import { type Context } from "hono";
import { setCookie } from "hono/cookie";

import { prisma } from "@server/core/database/client";
import { getConfig } from "@server/core/config";
import { decodeAccessToken } from "@server/core/auth/jwt";
import { failCode } from "@server/core/response";
import type { User } from "@prisma/client";

/** 鉴权 cookie 名：与 Next proxy.ts 的路由门共用 */
export const AUTH_COOKIE = "noxrea-auth-token";

/**
 * cookie 有效期与 JWT 过期时长保持一致：cookie 只是 JWT 的载体，
 * 若 cookie 比 JWT 寿命长，token 过期后 middleware 仍会凭 cookie 放行整页加载。
 * 每次签发时读取（而非模块导入时冻结），配置热更新/测试注入才能生效。
 */
function authCookieMaxAgeS() {
  return getConfig().JWT_EXPIRE_MINUTES * 60;
}

const AUTH_COOKIE_OPTS = { path: "/", httpOnly: true, sameSite: "Lax" } as const;

/** 签发鉴权 cookie 的唯一入口（maxAge 传 0 即过期清除，供登出使用） */
export function setAuthCookie(c: Context, token: string, maxAgeS = authCookieMaxAgeS()) {
  setCookie(c, AUTH_COOKIE, token, { ...AUTH_COOKIE_OPTS, maxAge: maxAgeS });
}

export interface AuthUser {
  id: number;
  username: string;
  avatarUrl: string | null;
  theme: string;
  language: string;
  isActive: boolean;
}

function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    username: user.username,
    avatarUrl: user.avatarUrl,
    theme: user.theme,
    language: user.language,
    isActive: user.isActive,
  };
}

/** 从 Authorization: Bearer 或鉴权 cookie 中提取 token */
function extractToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]*)`));
  if (!match) return null;
  // JWT 本身无需百分号编码，但浏览器可能发来畸形编码值；decode 失败按原值尝试，
  // 让后续 JWT 校验返回 401 而非在此抛 URIError 导致整个接口 500
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * 从 Request 中解析访问令牌（Bearer 头或 httpOnly cookie）并注入当前用户。
 * 失败返回 401 + 结构化错误码（前端按码取本地化文案）。
 */
export async function authenticateRequest(
  request: Request
): Promise<{ user: AuthUser } | { error: Response }> {
  const token = extractToken(request);
  if (!token) {
    return { error: failCode(401, "auth.not_authenticated") };
  }

  const payload = await decodeAccessToken(token);

  if (!payload) {
    return { error: failCode(401, "auth.token_invalid") };
  }

  const userId = parseInt(payload.sub, 10);
  if (isNaN(userId)) {
    return { error: failCode(401, "auth.token_invalid") };
  }

  const dbUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!dbUser || !dbUser.isActive) {
    return { error: failCode(401, "auth.user_inactive") };
  }

  // 凭据版本校验：密码修改会递增 tokenVersion，旧 token 立即失效（吊销能力）
  if (payload.ver !== dbUser.tokenVersion) {
    return { error: failCode(401, "auth.token_invalid") };
  }

  return { user: toAuthUser(dbUser) };
}
