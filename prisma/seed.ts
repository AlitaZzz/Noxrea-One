/**
 * Prisma Seed — 幂等创建管理员账号
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const username = process.env.ADMIN_USERNAME ?? "admin";
  const password = process.env.ADMIN_PASSWORD;

  if (!password || password === "change-me-to-a-strong-password") {
    console.warn(
      "[seed] ADMIN_PASSWORD is still the placeholder. Skipping admin creation for safety."
    );
    await prisma.$disconnect();
    return;
  }

  const existing = await prisma.user.findUnique({
    where: { username },
  });

  if (existing) {
    console.log(`[seed] Admin user "${username}" already exists. Skipping.`);
    await prisma.$disconnect();
    return;
  }

  const hashed = await bcrypt.hash(password, 12);

  await prisma.user.create({
    data: {
      username,
      hashedPassword: hashed,
      isActive: true,
      isSuperuser: true,
    },
  });

  console.log(`[seed] Admin user "${username}" created successfully.`);
}

main()
  .catch((err) => {
    console.error("[seed] Failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
