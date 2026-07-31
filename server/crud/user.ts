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

export async function updateUser(
  id: number,
  data: Record<string, unknown>
) {
  return prisma.user.update({
    where: { id },
    data,
  });
}
