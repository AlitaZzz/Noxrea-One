/**
 * 用户级写串行化（真实 PostgreSQL 库，specs/asset-write-serialization.md）。
 *
 * 同一用户的资产/目录/账本写事务会以不同顺序锁定多张表（创建：资产行 → 目录 →
 * 账本；删除：资产行 → 账本 → 目录；移动：资产行 → 旧目录 → 目标目录），交叉
 * 执行构成 ABBA 等待环，PostgreSQL 以 40P01 终止其中一个事务。修复在写事务入口
 * 获取按用户隔离的 pg_advisory_xact_lock，把同一用户的写串行化，跨用户保持并行；
 * 进程内闸门负责让排队发生在连接池之外（其行为见 user-write-lock.test.ts）。
 *
 * 本文件锁定数据库锁这一层（跨进程/跨实例的最终权威）：
 * 1. 独立事务持有用户锁时，写入口必须在该锁上等待；释放后完成。
 * 2. 跨用户：用户 A 的锁被持有时，用户 B 的写不等待 A 的锁，正常完成。
 * 3. 账本原语：画布/头像路径使用的 removeSourceFileRefsBatchTx 获取同一把锁。
 *
 * 持有者直接用 lockUserWriteTx 开事务（绕过进程闸门），因此观察到的是数据库
 * 锁等待；等待必须按持有者 pid + 锁键精确匹配（见 helpers/pg-locks）。
 */
import { Client } from "pg";
import type { PrismaClient } from "@server/core/database/generated/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { waitForAdvisoryLock, type Settled } from "../helpers/pg-locks";
import {
  databaseTestsEnabled,
  deleteTestUser,
  setupTestDatabase,
  testDatabaseUrl,
} from "../helpers/test-database";

let prisma: PrismaClient | null = null;
let createFolder: typeof import("@server/crud/asset").createFolder = null!;
let lockUserWriteTx: typeof import("@server/crud/user-write-lock").lockUserWriteTx = null!;
let removeSourceFileRefsBatchTx: typeof import("@server/crud/file-ref-ledger").removeSourceFileRefsBatchTx = null!;
let cleanup: (() => Promise<void>) | null = null;
let sequence = 0;

beforeAll(async () => {
  if (!databaseTestsEnabled) return;
  cleanup = await setupTestDatabase();
  // 环境变量就位后才能实例化客户端（连接串在构造时读取）
  const client = await import("@server/core/database/client");
  const asset = await import("@server/crud/asset");
  const lock = await import("@server/crud/user-write-lock");
  const ledger = await import("@server/crud/file-ref-ledger");
  prisma = client.prisma;
  createFolder = asset.createFolder;
  lockUserWriteTx = lock.lockUserWriteTx;
  removeSourceFileRefsBatchTx = ledger.removeSourceFileRefsBatchTx;
}, 60_000);

afterAll(async () => {
  await cleanup?.();
});

async function createUser(prefix: string) {
  sequence += 1;
  return prisma!.user.create({
    data: { username: `${prefix}-${sequence}`, hashedPassword: "h" },
  });
}

/** 记录 promise 的落定结果，供锁等待辅助区分「已阻塞」与「提前完成/失败」。 */
function track<T>(promise: Promise<T>, ref: { outcome: Settled | null }): Promise<T> {
  promise.then(
    () => {
      ref.outcome = { ok: true };
    },
    (error) => {
      ref.outcome = { ok: false, error };
    },
  );
  return promise;
}

/** 等 promise 在给定时间内完成；用于断言跨用户写没有被用户锁阻塞。 */
async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 未在 ${ms}ms 内完成`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 独立事务持有该用户的写锁，返回持有者后端 pid 与释放函数。
 * 直接调用 lockUserWriteTx 而不是写入口：绕过进程闸门，模拟另一实例的写入。
 */
async function startUserLockBlocker(userId: number) {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalHeld!: (pid: number) => void;
  const held = new Promise<number>((resolve) => {
    signalHeld = resolve;
  });

  const tx = prisma!.$transaction(
    async (dbTx) => {
      await lockUserWriteTx(dbTx, userId);
      const [row] = await dbTx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid() AS pid
      `;
      signalHeld(Number(row.pid));
      await hold;
    },
    { timeout: 15_000 },
  );

  return { pid: await held, release, tx };
}

describe.skipIf(!databaseTestsEnabled)("用户级写串行化（真实 PostgreSQL 库）", () => {
  it("外部事务持有用户锁时，写入口在该锁上等待；释放后完成", async () => {
    const user = await createUser("write-lock-serial");
    const observer = new Client({
      connectionString: testDatabaseUrl!,
      connectionTimeoutMillis: 8_000,
    });
    await observer.connect();

    const blocker = await startUserLockBlocker(user.id);
    const outcome: { outcome: Settled | null } = { outcome: null };
    let write: Promise<unknown> | null = null;

    try {
      write = track(createFolder(user.id, { name: "blocked-folder" }), outcome);
      await waitForAdvisoryLock(observer, {
        holderPid: blocker.pid,
        outcome: () => outcome.outcome,
        label: "createFolder",
      });

      blocker.release();
      const folder = await write;
      expect((folder as { name: string }).name).toBe("blocked-folder");
      await blocker.tx;
    } finally {
      blocker.release();
      await blocker.tx.catch(() => {});
      if (write) await write.catch(() => {});
      await observer.end();
      await deleteTestUser(prisma!, user.id);
    }
  }, 20_000);

  it("跨用户：他人写在本用户持锁期间完成，不等待该锁", async () => {
    const userA = await createUser("write-lock-a");
    const userB = await createUser("write-lock-b");
    const observer = new Client({
      connectionString: testDatabaseUrl!,
      connectionTimeoutMillis: 8_000,
    });
    await observer.connect();

    const blocker = await startUserLockBlocker(userA.id);
    const aOutcome: { outcome: Settled | null } = { outcome: null };
    let aWrite: Promise<unknown> | null = null;
    let bWrite: Promise<unknown> | null = null;

    try {
      aWrite = track(createFolder(userA.id, { name: "a-folder" }), aOutcome);
      await waitForAdvisoryLock(observer, {
        holderPid: blocker.pid,
        outcome: () => aOutcome.outcome,
        label: "用户 A 的写",
      });

      // 若锁键误用全局 key，B 的写会等待 A 的用户锁，无法在 2s 内完成。
      bWrite = createFolder(userB.id, { name: "b-folder" });
      const bFolder = await within(bWrite, 2_000, "用户 B 的写");
      expect((bFolder as { name: string }).name).toBe("b-folder");
      expect(aOutcome.outcome).toBeNull();

      blocker.release();
      const aFolder = await aWrite;
      expect((aFolder as { name: string }).name).toBe("a-folder");
      await blocker.tx;
    } finally {
      blocker.release();
      await blocker.tx.catch(() => {});
      if (aWrite) await aWrite.catch(() => {});
      if (bWrite) await bWrite.catch(() => {});
      await observer.end();
      await deleteTestUser(prisma!, userA.id);
      await deleteTestUser(prisma!, userB.id);
    }
  }, 20_000);

  it("账本原语在画布/头像路径上获取同一用户锁", async () => {
    const user = await createUser("write-lock-ledger");
    const observer = new Client({
      connectionString: testDatabaseUrl!,
      connectionTimeoutMillis: 8_000,
    });
    await observer.connect();

    const blocker = await startUserLockBlocker(user.id);
    const ledgerOutcome: { outcome: Settled | null } = { outcome: null };
    let ledgerWrite: Promise<unknown> | null = null;

    try {
      ledgerWrite = track(
        prisma!.$transaction((tx) =>
          removeSourceFileRefsBatchTx(tx, {
            userId: user.id,
            sourceType: "canvas",
            sourceIds: ["project-1"],
          }),
        ),
        ledgerOutcome,
      );
      await waitForAdvisoryLock(observer, {
        holderPid: blocker.pid,
        outcome: () => ledgerOutcome.outcome,
        label: "账本写",
      });

      blocker.release();
      await Promise.all([blocker.tx, ledgerWrite]);
      expect(ledgerOutcome.outcome).toEqual({ ok: true });
    } finally {
      blocker.release();
      await blocker.tx.catch(() => {});
      if (ledgerWrite) await ledgerWrite.catch(() => {});
      await observer.end();
      await deleteTestUser(prisma!, user.id);
    }
  }, 20_000);
});
