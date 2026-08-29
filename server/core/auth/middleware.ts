/**
 * 请求鉴权中间件。
 * 解析访问令牌、构造鉴权用户对象，并提供管理员初始化与权限校验。
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

// withAuth 高阶函数（鉴权用户注入）

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

// 管理员自动创建

export async function ensureAdminExists(
  adminUsername: string,
  adminPassword: string
): Promise<void> {
  const normalized = adminUsername.toLowerCase();
  const existing = await prisma.user.findUnique({
    where: { username: normalized },
  });
  if (existing) return;

  const { hashPassword } = await import("@server/core/auth/password");
  const hashed = await hashPassword(adminPassword);

  try {
    await prisma.user.create({
      data: {
        username: normalized,
        hashedPassword: hashed,
        isActive: true,
        isSuperuser: true,
      },
    });
  } catch (err: unknown) {
    // 唯一约束冲突 → 其他进程已创建，忽略
    const code = (err as Record<string, unknown>)?.code;
    if (code === "P2002" || code === "SQLITE_CONSTRAINT" || code === "SQLITE_CONSTRAINT_UNIQUE") {
      // 竞态条件：另一个进程已抢先创建了管理员，忽略即可
      return;
    }
    throw err;
  }
}

// 统一导出

export { toAuthUser };
