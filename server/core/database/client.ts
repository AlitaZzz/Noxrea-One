import { PrismaClient } from "@prisma/client";

// ── 全局单例（防 Next.js dev 热重载产生多实例） ──

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log:
      process.env.LOG_LEVEL === "DEBUG"
        ? ["query", "info", "warn", "error"]
        : ["warn", "error"],
  });

  return client;
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// ── SQLite PRAGMA（对应 Python lifespan 的 WAL 设置） ──

export async function applyPragmas(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
  if (!dbUrl.startsWith("file:")) return; // 非 SQLite 跳过

  const dbTimeout = parseInt(process.env.DB_TIMEOUT ?? "30", 10);
  // 防止 NaN 导致无效 SQL
  if (isNaN(dbTimeout) || dbTimeout <= 0) {
    // fallback 到默认 30 秒
    try {
      await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
      await prisma.$queryRawUnsafe("PRAGMA busy_timeout=30000");
    } catch {
      // WAL/busy_timeout 失败不阻塞启动
    }
    return;
  }

  try {
    // PRAGMA 语句在 SQLite 中会返回结果，需要用 $queryRawUnsafe
    await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
    await prisma.$queryRawUnsafe(
      `PRAGMA busy_timeout=${dbTimeout * 1000}`
    );
  } catch {
    // WAL/busy_timeout 失败不阻塞启动
  }
}
