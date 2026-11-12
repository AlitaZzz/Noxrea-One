/**
 * 批量创建同来源的并发回归（真实 PostgreSQL）。
 *
 * 旧实现是「事务内 findExistingIdentityKeys 查重 → 逐条 create」。READ COMMITTED 下
 * 两个并发批次都看不到对方未提交的行，均可通过查重；后到者插入时撞
 * asset_items_user_id_scope_file_key_key，P2002 让整个事务回滚，路由把整批映射为
 * 409。但批量语义本应是重复来源跳过（skipped: already_exists）——顺序重复也确实
 * 是跳过，只有并发重复会整批失败。
 *
 * 确定性编排：blocker 先锁住「未分类」目录行；首批次插入资产后阻塞在 direct_count
 * increment 上，此时它的资产行尚未提交。等首批次阻塞后启动第二批次：用户级写闸门
 * （specs/asset-write-serialization.md）让它在首批次提交前于进程内排队，不开启
 * 事务；释放 blocker 后首批次提交，第二批次在库内查重时看到已存在来源并按
 * skipped 跳过，而不是整批 409。
 *
 * 第三个用例直接验证单行插入原语的数据库裁决（绕过写闸门）：未提交的重复来源行
 * 提交后，`ON CONFLICT DO NOTHING` 返回空结果，由调用方按已存在跳过。
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
let createAssetsBatch: typeof import("@server/crud/asset").createAssetsBatch = null!;
let insertAssetItemRowTx: typeof import("@server/crud/asset").insertAssetItemRowTx = null!;
let cleanup: (() => Promise<void>) | null = null;
let sequence = 0;

beforeAll(async () => {
  if (!databaseTestsEnabled) return;
  cleanup = await setupTestDatabase();
  // 环境变量就位后才能实例化客户端（连接串在构造时读取）
  const client = await import("@server/core/database/client");
  const asset = await import("@server/crud/asset");
  prisma = client.prisma;
  createAssetsBatch = asset.createAssetsBatch;
  insertAssetItemRowTx = asset.insertAssetItemRowTx;
}, 60_000);

afterAll(async () => {
  await cleanup?.();
});

async function createUser() {
  sequence += 1;
  return prisma!.user.create({
    data: { username: `batch-create-race-${sequence}`, hashedPassword: "h" },
  });
}

describe.skipIf(!databaseTestsEnabled)("批量创建同来源并发（真实 PostgreSQL 库）", () => {
  it("后到批次跳过已存在来源，不再整批 409", async () => {
    const user = await createUser();
    const folder = await prisma!.assetFolder.create({
      data: { userId: user.id, name: "Uncategorized", kind: "uncategorized" },
    });
    const hash = "b".repeat(64);
    const fileKey = `${user.id}/bb/${hash}.png`;

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
    let first: ReturnType<typeof createAssetsBatch> | null = null;
    let second: ReturnType<typeof createAssetsBatch> | null = null;
    const firstOutcome: { outcome: Settled | null } = { outcome: null };

    try {
      await blocker.query("BEGIN");
      inTransaction = true;
      const locked = await blocker.query(
        `SELECT 1 FROM asset_folders WHERE id = $1 FOR UPDATE`,
        [folder.id],
      );
      if (locked.rowCount !== 1) {
        throw new Error(`blocker 未锁定未分类目录：rowCount=${locked.rowCount}`);
      }
      const blockerXid = await currentXid(blocker);

      first = createAssetsBatch([
        { userId: user.id, name: "first", type: "image", fileKey, folderId: null },
      ]);
      first.then(
        () => {
          firstOutcome.outcome = { ok: true };
        },
        (error) => {
          firstOutcome.outcome = { ok: false, error };
        },
      );

      // 首批次已插入资产、持有用户写锁，并阻塞在目录 direct_count increment 上。
      await waitForXidLock(blocker, {
        xid: blockerXid,
        excludePid: blockerPid,
        outcome: () => firstOutcome.outcome,
        label: "首批次",
      });

      second = createAssetsBatch([
        { userId: user.id, name: "second", type: "image", fileKey, folderId: null },
      ]);

      // 第二批次已进入用户写闸门排队（同进程等待不开启事务）；释放 blocker 后
      // 首批次提交，第二批次随后执行并按已存在来源跳过。
      await blocker.query("ROLLBACK");
      inTransaction = false;

      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.items).toHaveLength(1);
      expect(firstResult.items[0].fileKey).toBe(fileKey);
      expect(secondResult.items).toHaveLength(0);
      expect(secondResult.skipped).toContainEqual({ fileKey, reason: "already_exists" });

      const rows = await prisma!.assetItem.findMany({
        where: { userId: user.id, scope: "personal", fileKey },
        select: { id: true, folderId: true },
      });
      expect(rows).toHaveLength(1);
      const counts = await prisma!.assetFolder.findUnique({
        where: { id: folder.id },
        select: { directCount: true },
      });
      expect(counts?.directCount).toBe(1);
    } finally {
      if (inTransaction) await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end();
      if (first) await first.catch(() => {});
      if (second) await second.catch(() => {});
      await deleteTestUser(prisma!, user.id);
    }
  }, 20_000);

  it("无 fileKey 的条目不受唯一索引跳过影响", async () => {
    const user = await createUser();
    try {
      const result = await createAssetsBatch([
        { userId: user.id, name: "no-key-1", type: "text" },
        { userId: user.id, name: "no-key-2", type: "text" },
      ]);
      expect(result.items).toHaveLength(2);
      expect(result.items.every((item) => item.fileKey === null)).toBe(true);

      const rows = await prisma!.assetItem.findMany({
        where: { userId: user.id, scope: "personal" },
        select: { folderId: true },
      });
      expect(rows).toHaveLength(2);
      const folderIds = [...new Set(rows.map((row) => row.folderId))];
      expect(folderIds).toHaveLength(1);
      const counts = await prisma!.assetFolder.findUnique({
        where: { id: folderIds[0] },
        select: { directCount: true },
      });
      expect(counts?.directCount).toBe(2);
    } finally {
      await deleteTestUser(prisma!, user.id);
    }
  }, 15_000);

  it("重复来源的最终裁决由唯一索引完成：未提交行提交后本次插入返回 conflict", async () => {
    const user = await createUser();
    const folder = await prisma!.assetFolder.create({
      data: { userId: user.id, name: "Uncategorized", kind: "uncategorized" },
    });
    const hash = "e".repeat(64);
    const fileKey = `${user.id}/ee/${hash}.png`;

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
    let insert: Promise<unknown> | null = null;
    const outcome: { outcome: Settled | null } = { outcome: null };

    try {
      await blocker.query("BEGIN");
      inTransaction = true;
      // 胜方：直接写入同来源键但不提交。绕过写闸门，专门验证数据库最终裁决。
      await blocker.query(
        `INSERT INTO asset_items
           (user_id, folder_id, scope, file_key, source_type,
            name, type, media_type, description, tags, prompt)
         VALUES ($1, $2, 'personal', $3, 'upload',
                 'blocker', 'image', '', '', '[]', '')`,
        [user.id, folder.id, fileKey],
      );
      const blockerXid = await currentXid(blocker);

      insert = prisma!.$transaction((tx) =>
        insertAssetItemRowTx(tx, {
          userId: user.id,
          folderId: folder.id,
          scope: "personal",
          fileKey,
          sourceType: "upload",
          name: "late",
          type: "image",
          mediaType: "",
          description: "",
          tags: [],
          prompt: "",
        }),
      );
      insert.then(
        () => {
          outcome.outcome = { ok: true };
        },
        (error) => {
          outcome.outcome = { ok: false, error };
        },
      );

      // 插入撞上胜方未提交的唯一索引，进入事务等待；不能只看语句是否完成。
      await waitForXidLock(blocker, {
        xid: blockerXid,
        excludePid: blockerPid,
        outcome: () => outcome.outcome,
        label: "单行插入",
      });

      await blocker.query("COMMIT");
      inTransaction = false;

      await expect(insert).resolves.toEqual({ status: "conflict", fileKey });
      const rows = await prisma!.assetItem.findMany({
        where: { userId: user.id, scope: "personal", fileKey },
        select: { name: true },
      });
      expect(rows).toEqual([{ name: "blocker" }]);
    } finally {
      if (inTransaction) await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end();
      if (insert) await insert.catch(() => {});
      await deleteTestUser(prisma!, user.id);
    }
  }, 15_000);
});
