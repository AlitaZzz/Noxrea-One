import { prisma } from "@server/core/database/client";
import { decodeAccessToken } from "@server/core/auth/jwt";
import type { User } from "@prisma/client";

// ── Auth 用户类型（纯 TS 对象，非 Prisma 对象） ──

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

// ── withAuth 高阶函数（对应 Depends(get_current_user)） ──

/**
 * 从 Request 中解析 Bearer token 并注入当前用户。
 * 失败返回 401 + { detail }。
 */
export async function authenticateRequest(
  request: Request
): Promise<{ user: AuthUser } | { error: Response }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      error: Response.json(
        { detail: "未登录" },
        { status: 401 }
      ),
    };
  }

  const token = authHeader.slice(7);
  const payload = await decodeAccessToken(token);

  if (!payload) {
    return {
      error: Response.json(
        { detail: "Invalid or expired token" },
        { status: 401 }
      ),
    };
  }

  const userId = parseInt(payload.sub, 10);
  if (isNaN(userId)) {
    return {
      error: Response.json(
        { detail: "无效的令牌" },
        { status: 401 }
      ),
    };
  }

  const dbUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!dbUser || !dbUser.isActive) {
    return {
      error: Response.json(
        { detail: "用户不存在" },
        { status: 401 }
      ),
    };
  }

  return { user: toAuthUser(dbUser) };
}

// ── 管理员自动创建（对应 ensure_admin_exists） ──

export async function ensureAdminExists(
  adminUsername: string,
  adminPassword: string
): Promise<void> {
  const existing = await prisma.user.findUnique({
    where: { username: adminUsername },
  });
  if (existing) return;

  const { hashPassword } = await import("@server/core/auth/password");
  const hashed = await hashPassword(adminPassword);

  try {
    await prisma.user.create({
      data: {
        username: adminUsername,
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

// ── 统一导出 ──

export { toAuthUser };
