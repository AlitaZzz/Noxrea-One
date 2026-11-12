/**
 * 「未分类」目录并发首建的真实 PostgreSQL 回归。
 *
 * 旧实现是 findFirst → create → catch 唯一冲突 → 同事务 findFirst 回读；PostgreSQL
 * 中唯一冲突已把事务置为 aborted，回读必然 25P02，并发首访的败方请求 500。
 *
 * 确定性编排：独立 pg 连接先 BEGIN 并插入同键未提交行（胜方），再调用
 * getAssetLibrarySummary（败方）。败方的 findFirst 看不见未提交行，INSERT 阻塞在
 * 部分唯一索引上；用 pg_locks 按胜方 xid 确认阻塞（不能用 query 文本过滤：等待
 * 早期 pg_stat_activity 仍显示 BEGIN），然后 COMMIT 胜方。
 *
 * 胜方必须 COMMIT 而不是 ROLLBACK：回滚会让旧实现也成功（败方自行插入），测试
 * 将失去红灯保证；回滚路径由第二个用例单独锁定。
 *
 * 第三、四个用例锁定批量写入的目录提交时机：createAssetsBatch / updateAssetsBatch
 * 的整批事务可能持续数秒，未分类目录必须由进入整批事务前的独立短事务提交；
 * 否则并发首访会等待整批事务，超过 Prisma 交互式事务默认 5s 时以 P2028 失败。
 * 用例分别用 file_objects 行锁、旧目录行锁把批事务停在目录准备之后，断言此时
 * 目录已对独立连接可见。
 */
import { Client } from "pg";
import type { PrismaClient } from "@server/core/database/generated/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { currentXid, waitForXidLock, type Settled } from "../helpers/pg-locks";
import {
  databaseTestsEnabled,
  deleteTestUser,
  setupTestDatabase,
  testDatabaseUrl,
} from "../helpers/test-database";

let prisma: PrismaClient | null = null;
let getAssetLibrarySummary: typeof import("@server/crud/asset").getAssetLibrarySummary = null!;
let createAssetsBatch: typeof import("@server/crud/asset").createAssetsBatch = null!;
let updateAssetsBatch: typeof import("@server/crud/asset").updateAssetsBatch = null!;
let cleanup: (() => Promise<void>) | null = null;
let sequence = 0;

beforeAll(async () => {
  if (!databaseTestsEnabled) return;
  cleanup = await setupTestDatabase();
  // 环境变量就位后才能实例化客户端（连接串在构造时读取）
  const client = await import("@server/core/database/client");
  const asset = await import("@server/crud/asset");
  prisma = client.prisma;
  getAssetLibrarySummary = asset.getAssetLibrarySummary;
  createAssetsBatch = asset.createAssetsBatch;
  updateAssetsBatch = asset.updateAssetsBatch;
}, 60_000);

afterAll(async () => {
  await cleanup?.();
});

type Summary = Awaited<ReturnType<typeof getAssetLibrarySummary>>;
type Outcome = { ok: true; summary: Summary } | { ok: false; error: unknown };

async function createUser() {
  sequence += 1;
  return prisma!.user.create({
    data: { username: `uncategorized-race-${sequence}`, hashedPassword: "h" },
  });
}

/** 胜方：独立连接插入未提交的「未分类」行，返回事务 xid 与后端 pid 供门闩匹配。 */
async function startBlocker(userId: number) {
  const blocker = new Client({ connectionString: testDatabaseUrl!, connectionTimeoutMillis: 8_000 });
  await blocker.connect();
  await blocker.query("BEGIN");
  try {
    const inserted = await blocker.query<{ id: number }>(
      `INSERT INTO asset_folders (user_id, scope, name, kind, parent_id)
       VALUES ($1, 'personal', 'Uncategorized', 'uncategorized', NULL)
       RETURNING id`,
      [userId],
    );
    const { rows } = await blocker.query<{ xid: string; pid: number }>(
      `SELECT (pg_current_xact_id()::text::bigint & 4294967295)::text AS xid,
              pg_backend_pid() AS pid`,
    );
    return {
      blocker,
      manualId: inserted.rows[0].id,
      xid: rows[0].xid,
      pid: Number(rows[0].pid),
    };
  } catch (error) {
    await blocker.query("ROLLBACK").catch(() => {});
    await blocker.end().catch(() => {});
    throw error;
  }
}

async function uncategorizedRows(userId: number) {
  return prisma!.assetFolder.findMany({
    where: { userId, scope: "personal", kind: "uncategorized" },
    select: { id: true },
  });
}


describe.skipIf(!databaseTestsEnabled)("「未分类」目录并发首建（真实 PostgreSQL 库）", () => {
  it("胜方提交后，败方复用同一目录", async () => {
    const user = await createUser();
    const { blocker, manualId, xid, pid } = await startBlocker(user.id);
    let inTransaction = true;
    let summaryPromise: Promise<Summary> | null = null;
    const outcomeRef: { outcome: Outcome | null } = { outcome: null };

    try {
      summaryPromise = getAssetLibrarySummary(user.id);
      summaryPromise.then(
        (summary) => {
          outcomeRef.outcome = { ok: true, summary };
        },
        (error) => {
          outcomeRef.outcome = { ok: false, error };
        },
      );

      await waitForXidLock(blocker, {
        xid,
        excludePid: pid,
        outcome: () => outcomeRef.outcome,
        label: "getAssetLibrarySummary",
      });

      // 胜负在此刻才分出：胜方提交后败方的 INSERT 撞索引，旧实现在 catch 回读时 25P02。
      await blocker.query("COMMIT");
      inTransaction = false;

      const summary = await summaryPromise;
      expect(summary.folders).toHaveLength(1);
      const rows = await uncategorizedRows(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(manualId);
    } finally {
      if (inTransaction) await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end();
      if (summaryPromise) await summaryPromise.catch(() => {});
      await deleteTestUser(prisma!, user.id);
    }
  }, 15_000);

  it("胜方回滚后，败方自行创建目录", async () => {
    const user = await createUser();
    const { blocker, manualId, xid, pid } = await startBlocker(user.id);
    let inTransaction = true;
    let summaryPromise: Promise<Summary> | null = null;
    const outcomeRef: { outcome: Outcome | null } = { outcome: null };

    try {
      summaryPromise = getAssetLibrarySummary(user.id);
      summaryPromise.then(
        (summary) => {
          outcomeRef.outcome = { ok: true, summary };
        },
        (error) => {
          outcomeRef.outcome = { ok: false, error };
        },
      );

      await waitForXidLock(blocker, {
        xid,
        excludePid: pid,
        outcome: () => outcomeRef.outcome,
        label: "getAssetLibrarySummary",
      });

      await blocker.query("ROLLBACK");
      inTransaction = false;

      const summary = await summaryPromise;
      expect(summary.folders).toHaveLength(1);
      const rows = await uncategorizedRows(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).not.toBe(manualId);
    } finally {
      if (inTransaction) await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end();
      if (summaryPromise) await summaryPromise.catch(() => {});
      await deleteTestUser(prisma!, user.id);
    }
  }, 15_000);

  it("批事务等待 file_objects 行锁时，未分类目录已提交并对独立连接可见", async () => {
    const user = await createUser();
    const hash = "a".repeat(64);
    const fileKey = `${user.id}/aa/${hash}.png`;
    await prisma!.fileObject.create({ data: { userId: user.id, hash } });

    const blocker = new Client({
      connectionString: testDatabaseUrl!,
      connectionTimeoutMillis: 8_000,
    });
    await blocker.connect();
    const { rows: pidRows } = await blocker.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const blockerPid = Number(pidRows[0].pid);
    let inTransaction = false;
    let batchPromise: ReturnType<typeof createAssetsBatch> | null = null;
    const outcomeRef: { outcome: Settled | null } = { outcome: null };

    try {
      await blocker.query("BEGIN");
      inTransaction = true;
      const locked = await blocker.query(
        `SELECT 1 FROM file_objects WHERE user_id = $1 AND hash = $2 FOR UPDATE`,
        [user.id, hash],
      );
      if (locked.rowCount !== 1) {
        throw new Error(`blocker 未锁定 file_objects 行：rowCount=${locked.rowCount}`);
      }
      const xid = await currentXid(blocker);

      batchPromise = createAssetsBatch([
        {
          userId: user.id,
          name: "blocked-asset",
          type: "image",
          fileKey,
          folderId: null,
        },
      ]);
      batchPromise.then(
        () => {
          outcomeRef.outcome = { ok: true };
        },
        (error) => {
          outcomeRef.outcome = { ok: false, error };
        },
      );

      await waitForXidLock(blocker, {
        xid,
        excludePid: blockerPid,
        outcome: () => outcomeRef.outcome,
        label: "createAssetsBatch",
      });

      // 批事务已越过目录准备并阻塞在 file_objects 行锁上。目录必须已提交：
      // 否则并发首访的 ON CONFLICT 会等待整批事务，>5s 时以 P2028 失败。
      const during = await uncategorizedRows(user.id);
      expect(during).toHaveLength(1);
      const visibleId = during[0].id;

      await blocker.query("ROLLBACK");
      inTransaction = false;

      const result = await batchPromise;
      expect(result.items).toHaveLength(1);
      expect(result.items[0].folderId).toBe(visibleId);
      const after = await uncategorizedRows(user.id);
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(visibleId);
    } finally {
      if (inTransaction) await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end();
      if (batchPromise) await batchPromise.catch(() => {});
      await deleteTestUser(prisma!, user.id);
    }
  }, 15_000);

  it("批量移动等待旧目录行锁时，未分类目录已提交并对独立连接可见", async () => {
    const user = await createUser();
    const source = await prisma!.assetFolder.create({
      data: { userId: user.id, name: "source-folder", directCount: 1 },
    });
    const asset = await prisma!.assetItem.create({
      data: { userId: user.id, folderId: source.id, name: "moving-asset" },
    });

    const blocker = new Client({
      connectionString: testDatabaseUrl!,
      connectionTimeoutMillis: 8_000,
    });
    await blocker.connect();
    const { rows: pidRows } = await blocker.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const blockerPid = Number(pidRows[0].pid);
    let inTransaction = false;
    let batchPromise: ReturnType<typeof updateAssetsBatch> | null = null;
    const outcomeRef: { outcome: Settled | null } = { outcome: null };

    try {
      await blocker.query("BEGIN");
      inTransaction = true;
      const locked = await blocker.query(
        `SELECT 1 FROM asset_folders WHERE id = $1 FOR UPDATE`,
        [source.id],
      );
      if (locked.rowCount !== 1) {
        throw new Error(`blocker 未锁定源目录：rowCount=${locked.rowCount}`);
      }
      const xid = await currentXid(blocker);

      batchPromise = updateAssetsBatch(user.id, [asset.id], { folderId: null });
      batchPromise.then(
        () => {
          outcomeRef.outcome = { ok: true };
        },
        (error) => {
          outcomeRef.outcome = { ok: false, error };
        },
      );

      await waitForXidLock(blocker, {
        xid,
        excludePid: blockerPid,
        outcome: () => outcomeRef.outcome,
        label: "updateAssetsBatch",
      });

      // 批事务已越过目录准备并阻塞在旧目录行锁上；目录必须已提交，否则并发首访
      // 会等待整批更新，>5s 时以 P2028 失败。
      const during = await uncategorizedRows(user.id);
      expect(during).toHaveLength(1);
      const visibleId = during[0].id;

      await blocker.query("ROLLBACK");
      inTransaction = false;

      const result = await batchPromise;
      expect(result.count).toBe(1);
      const moved = await prisma!.assetItem.findUnique({
        where: { id: asset.id },
        select: { folderId: true },
      });
      expect(moved?.folderId).toBe(visibleId);
      const after = await uncategorizedRows(user.id);
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(visibleId);
    } finally {
      if (inTransaction) await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end();
      if (batchPromise) await batchPromise.catch(() => {});
      await deleteTestUser(prisma!, user.id);
    }
  }, 15_000);
});
