/**
 * 用户 CRUD。
 * 按 ID 与用户名查询用户信息，用户名匹配大小写不敏感。
 */
import { prisma } from "@server/core/database/client";
import { Prisma, type User } from "@prisma/client";

export async function getUserById(id: number) {
  return prisma.user.findUnique({ where: { id } });
}

export async function getUserByUsername(username: string) {
  // 用户名大小写不敏感：统一按小写匹配
  return prisma.user.findUnique({ where: { username: username.toLowerCase() } });
}

/** 判断唯一约束冲突是否来自用户名：注册查重在事务外，并发同名注册的败方会撞到该约束。 */
export function isUsernameTakenError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  const targetText = Array.isArray(target) ? target.join(":") : String(target ?? "");
  return targetText.includes("username");
}

export async function createUser(data: {
  username: string;
  hashedPassword: string;
}) {
  // 首个注册用户自动 admin：判定在创建事务内（语义为"注册时无其他用户"）。
  // SQLite 写入经 Prisma 连接串行化，并发首注册不会产生双 admin（user.test.ts 并发用例锁定）。
  return prisma.$transaction(async (tx) => {
    const role = (await tx.user.count()) === 0 ? "admin" : "user";
    return tx.user.create({
      data: {
        // 用户名统一小写存储，保证大小写不敏感且符合唯一约束
        username: data.username.toLowerCase(),
        hashedPassword: data.hashedPassword,
        role,
      },
    });
  });
}

/** 登录成功后写入最后登录时间。 */
export async function touchLastLogin(id: number) {
  return prisma.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
}

/** 用户可更新字段白名单 */
type UpdatableUserFields = {
  avatarUrl?: string;
  theme?: string;
  language?: string;
  isActive?: boolean;
};

/**
 * 对外安全的用户视图：剔除 hashedPassword 等敏感字段。
 * 所有返回给 HTTP 客户端的 user 对象都必须经此转换。
 * displayName 展示回退约定：为空时按 username 回退（Spec user-table-upgrade），消费方不做二次回退。
 */
export function toPublicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? user.username,
    email: user.email,
    role: user.role,
    avatarUrl: user.avatarUrl,
    theme: user.theme,
    language: user.language,
    isActive: user.isActive,
  };
}

/** 修改密码的唯一入口：写入新哈希并递增凭据版本号，旧 JWT 立即失效 */
export async function setUserPassword(id: number, hashedPassword: string) {
  return prisma.user.update({
    where: { id },
    data: { hashedPassword, tokenVersion: { increment: 1 } },
  });
}

export async function updateUser(
  id: number,
  data: UpdatableUserFields
) {
  // 白名单过滤：仅允许安全字段更新，防止直接设置 hashedPassword 等敏感字段
  const allowed: Record<string, unknown> = {};
  const allowedKeys = new Set(["avatarUrl", "theme", "language", "isActive"]);
  for (const [key, val] of Object.entries(data)) {
    if (allowedKeys.has(key) && val !== undefined) {
      allowed[key] = val;
    }
  }

  return prisma.user.update({
    where: { id },
    data: allowed,
  });
}
