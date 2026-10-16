/**
 * 数据库客户端工厂（双模式、单方言 PostgreSQL，specs/postgres-dialect-unification.md）。
 *  - DATABASE_URL 为 postgres(ql)://：服务器模式 —— 官方 adapter-pg 连真 PG；
 *    迁移由部署侧 `prisma migrate deploy` 负责，应用内不做迁移。
 *  - DATABASE_URL 为 file:<dir> 或未设置：本地模式 —— PGlite（进程内 PG），
 *    数据目录取 URL 路径或默认 data/pglite；启动时由迁移 runner 应用 prisma/migrations 增量。
 * 两种模式共用同一份生成的 PrismaClient 与同一份迁移目录（单一演进源）。
 *
 * 实例按「连接目标」缓存在 globalThis：本地模式按数据目录、服务器模式按连接串。
 * 必须按目标而非模块实例缓存——vitest 单 fork 跑多个测试文件时模块注册表按文件重建，
 * 但 globalThis 存活于整个进程；模块级实例会让后一个文件拿到前一个文件已 close 的客户端。
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { Prisma, PrismaClient } from "./generated/client";
import { runPendingMigrations } from "./migrate";

interface DatabaseEntry {
  prisma: PrismaClient;
  pglite?: PGlite;
  /** 本地模式迁移 runner 是否已在本实例上跑完（幂等标记） */
  migrated: boolean;
}

const globalForPrisma = globalThis as unknown as {
  databases?: Map<string, DatabaseEntry>;
  lockFd?: number;
};

/** 本地模式数据目录锁文件名（防同目录多实例：PGlite 无实例互斥，双开会静默互相破坏）。 */
const LOCK_FILE = "noxrea.lock";

function isServerDatabaseUrl(url: string): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

/** 服务器模式（真 PG）＝ true；本地模式（PGlite）＝ false。 */
export function isServerMode(): boolean {
  return isServerDatabaseUrl(process.env.DATABASE_URL ?? "");
}

/** 当前连接目标的可读描述（供启动日志）：pg 用户@host:port/库 或 pglite 数据目录；密码一律不出现。 */
export function describeConnectionTarget(): string {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (isServerDatabaseUrl(dbUrl)) {
    const url = new URL(dbUrl);
    const user = url.username ? `${url.username}@` : "";
    return `pg ${user}${url.host}${url.pathname}`;
  }
  return `pglite ${resolveLocalDataDir()}`;
}

/** 本地模式数据目录：DATABASE_URL=file:<dir> 显式指定，否则默认 data/pglite（相对进程 cwd）。 */
function resolveLocalDataDir(): string {
  const url = process.env.DATABASE_URL ?? "";
  if (url.startsWith("file:")) return path.resolve(url.slice("file:".length));
  return path.resolve("data", "pglite");
}

/** 本地模式数据目录锁：O_EXCL 创建 + 写入持锁进程 PID；陈旧锁（持锁进程已死）自动接管。 */
function acquireDataDirLock(dataDir: string): void {
  const lockPath = path.join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      // fd 刻意保持打开：句柄随进程存活，释放统一走 releaseDataDirLock
      globalForPrisma.lockFd = fd;
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let pid: number | null = null;
      try {
        pid = (JSON.parse(readFileSync(lockPath, "utf8") ) as { pid?: number }).pid ?? null;
      } catch { /* 锁文件损坏，按无 PID 处理 */ }
      if (pid !== null && pid !== process.pid) {
        try {
          process.kill(pid, 0);
        } catch {
          unlinkSync(lockPath); // 持锁进程已死：清陈旧锁重试一次
          continue;
        }
        throw new Error(
          `本地数据库目录已被另一个 Noxrea 进程占用（PID ${pid}）。` +
            `PGlite 不允许对同一数据目录开多个实例（会静默损坏数据），请先关闭已运行的实例。`,
        );
      }
      unlinkSync(lockPath); // 锁文件无 PID 或损坏：按残留清理重试
    }
  }
  throw new Error("本地数据库目录锁获取失败（锁文件竞争），请重试。");
}

function releaseDataDirLock(): void {
  const fd = globalForPrisma.lockFd;
  if (fd === undefined) return;
  globalForPrisma.lockFd = undefined;
  try { closeSync(fd); } catch { /* 句柄可能已随异常路径关闭 */ }
  try { unlinkSync(path.join(resolveLocalDataDir(), LOCK_FILE)); } catch { /* 目录可能已被清理 */ }
}

function getEntry(): DatabaseEntry {
  const dbUrl = process.env.DATABASE_URL ?? "";
  const isServer = isServerDatabaseUrl(dbUrl);
  const key = isServer ? `pg:${dbUrl}` : `file:${resolveLocalDataDir()}`;
  globalForPrisma.databases ??= new Map();
  const existing = globalForPrisma.databases.get(key);
  if (existing) return existing;

  const log: Prisma.LogLevel[] =
    process.env.LOG_LEVEL === "DEBUG"
      ? ["query", "info", "warn", "error"]
      : ["warn", "error"];

  let entry: DatabaseEntry;
  if (isServer) {
    entry = {
      prisma: new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }), log }),
      migrated: true,
    };
  } else {
    const dataDir = resolveLocalDataDir();
    // PGlite 建目录非递归：首次启动（数据目录父级不存在）会 ENOENT，这里补齐
    mkdirSync(dataDir, { recursive: true });
    acquireDataDirLock(dataDir);
    const pglite = new PGlite(dataDir);
    entry = {
      prisma: new PrismaClient({ adapter: new PrismaPGlite(pglite), log }),
      pglite,
      migrated: false,
    };
  }
  globalForPrisma.databases.set(key, entry);
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
 * 关闭当前数据库实例并释放本地模式数据目录锁（graceful shutdown 与测试基座共用）。
 * 必须先 close 再释放锁：close 触发 checkpoint 把 WAL 落盘，是正常退出路径的
 * 最后一道耐久性保障；先放锁会让其他进程在 checkpoint 完成前打开同一数据目录。
 * 服务器模式无本地实例，仅清缓存。
 */
export async function closeLocalDatabase(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? "";
  const key = isServerDatabaseUrl(dbUrl) ? `pg:${dbUrl}` : `file:${resolveLocalDataDir()}`;
  const entry = globalForPrisma.databases?.get(key);
  globalForPrisma.databases?.delete(key);
  await entry?.pglite?.close();
  releaseDataDirLock();
}

/**
 * 本地模式启动迁移：应用 prisma/migrations 增量（幂等，每实例只执行一次）。
 * 服务器模式为 no-op（部署侧 migrate deploy 负责）。bootstrap 与测试基座共用此入口。
 */
export async function ensureLocalMigrations(): Promise<void> {
  if (isServerMode()) return;
  const entry = getEntry();
  if (!entry.pglite) throw new Error("本地模式 PGlite 实例未初始化");
  if (entry.migrated) return;
  await runPendingMigrations(entry.pglite);
  entry.migrated = true;
}
