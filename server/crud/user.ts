import { prisma } from "@server/core/database/client";

// ── User CRUD（对应 backend/app/crud/user.py） ──

export async function getUserById(id: number) {
  return prisma.user.findUnique({ where: { id } });
}

export async function getUserByUsername(username: string) {
  return prisma.user.findUnique({ where: { username } });
}

export async function createUser(data: {
  username: string;
  hashedPassword: string;
  email?: string;
}) {
  return prisma.user.create({
    data: {
      username: data.username,
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
