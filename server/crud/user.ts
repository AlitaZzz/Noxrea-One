/**
 * 用户 CRUD。
 * 按 ID 与用户名查询用户信息，用户名匹配大小写不敏感。
 */
import { prisma } from "@server/core/database/client";
import type { User } from "@prisma/client";

export async function getUserById(id: number) {
  return prisma.user.findUnique({ where: { id } });
}

export async function getUserByUsername(username: string) {
  // 用户名大小写不敏感：统一按小写匹配
  return prisma.user.findUnique({ where: { username: username.toLowerCase() } });
}

export async function createUser(data: {
  username: string;
  hashedPassword: string;
}) {
  return prisma.user.create({
    data: {
      // 用户名统一小写存储，保证大小写不敏感且符合唯一约束
      username: data.username.toLowerCase(),
      hashedPassword: data.hashedPassword,
    },
  });
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
 */
export function toPublicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
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
