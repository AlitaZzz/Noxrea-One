/**
 * 请求鉴权中间件。
 * 解析访问令牌、构造鉴权用户对象。JWT 签发/校验与密码哈希等纯逻辑在 core/auth。
 */
import { prisma } from "@server/core/database/client";
import { decodeAccessToken } from "@server/core/auth/jwt";
import { failCode } from "@server/core/response";
import type { User } from "@prisma/client";

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

/**
 * 从 Request 中解析 Bearer token 并注入当前用户。
 * 失败返回 401 + 结构化错误码（前端按码取本地化文案）。
 */
export async function authenticateRequest(
  request: Request
): Promise<{ user: AuthUser } | { error: Response }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { error: failCode(401, "auth.not_authenticated") };
  }

  const token = authHeader.slice(7);
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

  return { user: toAuthUser(dbUser) };
}
