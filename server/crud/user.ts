/**
 * 用户 CRUD。
 * 按 ID 与用户名查询用户信息，用户名匹配大小写不敏感。
 */
import { prisma } from "@server/core/database/client";

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
  email?: string;
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
