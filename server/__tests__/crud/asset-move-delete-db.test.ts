/**
 * 资产移动/删除的真实 PostgreSQL 回归。
 *
 * - `DELETE ... RETURNING` 的元组谓词与目录计数只认实际删除行，不能只在内存 mock 上验证；
 * - 移动路径在读取旧目录前用 `SELECT ... FOR UPDATE` 锁定资产行，并发移动/删除必须串行化，
 *   否则后到事务会按陈旧快照对旧目录重复递减、给目标目录留下无对应资产的计数。
 *
 * 并发用例用独立 `pg` 连接持有资产行锁，再启动 `updateAssetsBatch`，确认它在行锁上等待后
 * 由持锁连接完成一次真实移动：未加锁时会按移动前的旧目录重复递减，加锁后按提交后的目录结算。
 */
import { Client } from "pg";
import type { PrismaClient } from "@server/core/database/generated/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseTestsEnabled, setupTestDatabase, testDatabaseUrl } from "../helpers/test-database";

let prisma: PrismaClient | null = null;
let deleteAssetItemsTx: typeof import("@server/crud/asset").deleteAssetItemsTx = null!;
let updateAsset: typeof import("@server/crud/asset").updateAsset = null!;
let updateAssetsBatch: typeof import("@server/crud/asset").updateAssetsBatch = null!;
let deleteFolder: typeof import("@server/crud/asset").deleteFolder = null!;
let cleanup: (() => Promise<void>) | null = null;

beforeAll(async () => {
  cleanup = await setupTestDatabase();
  // 环境变量就位后才能实例化客户端（连接串在构造时读取）
  const client = await import("@server/core/database/client");
  const asset = await import("@server/crud/asset");
  prisma = client.prisma;
  deleteAssetItemsTx = asset.deleteAssetItemsTx;
  updateAsset = asset.updateAsset;
  updateAssetsBatch = asset.updateAssetsBatch;
  deleteFolder = asset.deleteFolder;
}, 60_000);

afterAll(async () => {
  await cleanup?.();
});

let sequence = 0;
function uniqueName(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

async function createUser(prefix: string) {
  return prisma!.user.create({
    data: { username: uniqueName(prefix), hashedPassword: "test-hash" },
  });
}

async function createFolder(userId: number, name: string, directCount = 0) {
  return prisma!.assetFolder.create({
    data: { userId, name: uniqueName(name), directCount },
  });
}

async function createAsset(userId: number, folderId: number) {
  return prisma!.assetItem.create({
    data: { userId, folderId, name: uniqueName("asset") },
  });
}

async function folderCounts(userId: number): Promise<Record<number, number>> {
  const folders = await prisma!.assetFolder.findMany({
    where: { userId },
    select: { id: true, directCount: true },
  });
  return Object.fromEntries(folders.map((folder) => [folder.id, folder.directCount]));
}

/** 等待 updateAssetsBatch 的查询进入 PostgreSQL 锁等待，证明它确实被资产行锁阻塞。 */
async function waitForLockWait(blocker: Client): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await blocker.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND wait_event = 'transactionid'`,
    );
    if (Number(rows[0]?.count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("updateAssetsBatch 未在资产行锁上等待，移动路径可能没有加锁");
}

describe.skipIf(!databaseTestsEnabled)("资产移动/删除（真实 PostgreSQL 库）", () => {
  it("DELETE ... RETURNING 按 (id, user_id) 成对匹配，混合所有者不会交叉命中", async () => {
    const userA = await createUser("tuple-a");
    const userB = await createUser("tuple-b");
    const folderA = await createFolder(userA.id, "folder-a", 1);
    const folderB = await createFolder(userB.id, "folder-b", 1);
    const assetA = await createAsset(userA.id, folderA.id);
    const assetB = await createAsset(userB.id, folderB.id);

    // 交叉传入 (A 的 id, B 的 userId) 与 (B 的 id, A 的 userId)：成对谓词不应命中任何一行。
    const crossed = await prisma!.$transaction((tx) =>
      deleteAssetItemsTx(tx, [
        { id: assetA.id, userId: userB.id },
        { id: assetB.id, userId: userA.id },
      ]),
    );
    expect(crossed).toEqual([]);
    expect(await prisma!.assetItem.count({ where: { id: { in: [assetA.id, assetB.id] } } })).toBe(2);

    const deleted = await prisma!.$transaction((tx) =>
      deleteAssetItemsTx(tx, [
        { id: assetA.id, userId: userA.id },
        { id: assetB.id, userId: userB.id },
      ]),
    );
    expect(deleted.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [assetA.id, assetB.id].sort((a, b) => a - b),
    );
    expect(await prisma!.assetItem.count({ where: { id: { in: [assetA.id, assetB.id] } } })).toBe(0);
    expect(await folderCounts(userA.id)).toEqual({ [folderA.id]: 0 });
    expect(await folderCounts(userB.id)).toEqual({ [folderB.id]: 0 });
  });

  it("deleteFolder 按 RETURNING 的实际删除集清理资产与子树目录", async () => {
    const user = await createUser("folder-delete");
    const root = await createFolder(user.id, "root", 1);
    const child = await prisma!.assetFolder.create({
      data: { userId: user.id, name: uniqueName("child"), parentId: root.id, directCount: 1 },
    });
    await createAsset(user.id, root.id);
    await createAsset(user.id, child.id);

    const result = await deleteFolder(user.id, root.id);

    expect(result.removedCount).toBe(2);
    expect(await prisma!.assetItem.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma!.assetFolder.count({ where: { userId: user.id } })).toBe(0);
  });

  it("单条移动按锁定行结算目录计数", async () => {
    const user = await createUser("move-single");
    const source = await createFolder(user.id, "source", 1);
    const target = await createFolder(user.id, "target", 0);
    const asset = await createAsset(user.id, source.id);

    await updateAsset(user.id, asset.id, { folderId: target.id });

    expect(await folderCounts(user.id)).toEqual({ [source.id]: 0, [target.id]: 1 });
    expect((await prisma!.assetItem.findUnique({ where: { id: asset.id } }))?.folderId).toBe(target.id);
  });

  it(
    "并发移动后按锁定行结算，不重复扣减旧目录",
    async () => {
      const user = await createUser("move-race");
      const first = await createFolder(user.id, "first", 1);
      const target = await createFolder(user.id, "target", 0);
      const concurrent = await createFolder(user.id, "concurrent", 0);
      const asset = await createAsset(user.id, first.id);

      const blocker = new Client({ connectionString: testDatabaseUrl! });
      await blocker.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT 1 FROM asset_items WHERE id = $1 FOR UPDATE", [asset.id]);

        // 目标移动 F1 -> target；它必须先等待 blocker 持有的资产行锁。
        const move = updateAssetsBatch(user.id, [asset.id], { folderId: target.id });
        await waitForLockWait(blocker);

        // blocker 完成一次竞态移动 F1 -> concurrent，并同步目录计数后提交。
        await blocker.query("UPDATE asset_items SET folder_id = $1 WHERE id = $2", [concurrent.id, asset.id]);
        await blocker.query("UPDATE asset_folders SET direct_count = direct_count - 1 WHERE id = $1", [first.id]);
        await blocker.query("UPDATE asset_folders SET direct_count = direct_count + 1 WHERE id = $1", [concurrent.id]);
        await blocker.query("COMMIT");

        await move;
      } finally {
        await blocker.end();
      }

      expect(await folderCounts(user.id)).toEqual({
        [first.id]: 0,
        [target.id]: 1,
        [concurrent.id]: 0,
      });
      expect((await prisma!.assetItem.findUnique({ where: { id: asset.id } }))?.folderId).toBe(target.id);
    },
    15_000,
  );
});
