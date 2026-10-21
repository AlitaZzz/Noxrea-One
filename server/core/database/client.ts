/**
 * 数据库客户端工厂（单一运行时：PostgreSQL，specs/pglite-removal.md）。
 * DATABASE_URL 必填且必须是 postgres(ql)://；缺失或非法在首次数据库访问前大声失败。
 * 应用启动不执行迁移：schema 由部署侧 `prisma migrate deploy`（entrypoint / 流水线）负责。
 *
 * 实例按连接串缓存在 globalThis：vitest 单进程跑多个测试文件时模块注册表按文件重建，
 * 但 globalThis 存活于整个进程；模块级实例会让后一个文件拿到前一个文件已 close 的客户端。
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/client";
import { assertDatabaseUrl } from "./connection-string";

interface DatabaseEntry {
  prisma: PrismaClient;
}

const globalForPrisma = globalThis as unknown as {
  databases?: Map<string, DatabaseEntry>;
};

function getEntry(): DatabaseEntry {
  const dbUrl = assertDatabaseUrl();
  globalForPrisma.databases ??= new Map();
  const existing = globalForPrisma.databases.get(dbUrl);
  if (existing) return existing;

  const log: Prisma.LogLevel[] =
    process.env.LOG_LEVEL === "DEBUG"
      ? ["query", "info", "warn", "error"]
      : ["warn", "error"];

  const entry: DatabaseEntry = {
    prisma: new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }), log }),
  };
  globalForPrisma.databases.set(dbUrl, entry);
  return entry;
}

/**
 * 进程级共享 Prisma 客户端（惰性）：导入本模块不得产生文件系统副作用（如 ffmpeg 等纯
 * 工具模块的测试也会传递导入本文件），首次实际访问属性时才按当前 DATABASE_URL 实例化。
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getEntry().prisma;
    const value = Reflect.get(client, property, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

/**
 * 关闭当前 DATABASE_URL 对应的数据库实例并清缓存（优雅停机与测试基座共用）。
 * 测试 helper 必须在恢复环境变量之前调用；环境变量已切换时不会误关其他连接串的实例。
 */
export async function closeDatabase(): Promise<void> {
  const databases = globalForPrisma.databases;
  if (!databases) return;
  const key = process.env.DATABASE_URL ?? "";
  const entry = databases.get(key);
  if (!entry) return;
  databases.delete(key);
  await entry.prisma.$disconnect();
}
