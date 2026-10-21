/**
 * updateUser 头像引用账本同步（specs/storage-s3-backend.md GC 引用闭环）的真实库回归测试。
 * 锁定：设置头像入账本（avatar 来源，ref_count 同步递增）、换头像旧减新增、
 * 置空清行减引用、白名单外字段丢弃、非 avatarKey 更新不触碰账本。
 */
import fs from "fs";
import path from "path";
import type { PrismaClient } from "@server/core/database/generated/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashFromStorageKey } from "@noxrea/shared/url";

import { databaseTestsEnabled, setupTestDatabase } from "../helpers/test-database";

let prisma: PrismaClient | null = null;
let updateUser: typeof import("@server/crud/user").updateUser = null!;
let UserAvatarKeyError: typeof import("@server/crud/user").UserAvatarKeyError = null!;
let cleanup: (() => Promise<void>) | null = null;

beforeAll(async () => {
  cleanup = await setupTestDatabase();
  const client = await import("@server/core/database/client");
  const crud = await import("@server/crud/user");
  prisma = client.prisma;
  updateUser = crud.updateUser;
  UserAvatarKeyError = crud.UserAvatarKeyError;
}, 60_000);

afterAll(async () => {
  await cleanup?.();
});

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

/** 造用户与其头像对应的 file_objects 聚合行（模拟上传完成后的库内状态） */
async function setupUserWithObjects(): Promise<{ id: number; key1: string; key2: string }> {
  const user = await prisma!.user.create({ data: { username: `avatar-${Date.now()}-${Math.random()}`, hashedPassword: "h" } });
  for (const hash of [H1, H2]) {
    await prisma!.fileObject.create({
      data: { userId: user.id, hash, size: 100, ext: ".png", mimeType: "image/png", refCount: 0 },
    });
  }
  return {
    id: user.id,
    key1: `${user.id}/${H1.slice(0, 2)}/${H1}.png`,
    key2: `${user.id}/${H2.slice(0, 2)}/${H2}.png`,
  };
}

beforeEach(async () => {
  await prisma!.fileRef.deleteMany();
  await prisma!.fileObject.deleteMany();
  await prisma!.user.deleteMany();
});

const ledgerRow = (userId: number, hash: string) =>
  prisma!.fileRef.findFirst({
    where: { userId, sourceType: "avatar", sourceId: String(userId), hash },
  });
const objectRow = (userId: number, hash: string) =>
  prisma!.fileObject.findUnique({ where: { userId_hash: { userId, hash } } });

describe.skipIf(!databaseTestsEnabled)("updateUser 头像账本同步（真实 PostgreSQL 库）", () => {
  it("设置头像：avatar 账本行 count=1，ref_count 递增到 1", async () => {
    const u = await setupUserWithObjects();

    await updateUser(u.id, { avatarKey: u.key1 });

    expect(await ledgerRow(u.id, H1)).toMatchObject({ count: 1 });
    expect((await objectRow(u.id, H1))?.refCount).toBe(1);
    expect((await prisma!.user.findUnique({ where: { id: u.id } }))?.avatarKey).toBe(u.key1);
  });

  it("换头像：旧账本行删除、旧 ref_count 归零，新行建立", async () => {
    const u = await setupUserWithObjects();
    await updateUser(u.id, { avatarKey: u.key1 });

    await updateUser(u.id, { avatarKey: u.key2 });

    expect(await ledgerRow(u.id, H1)).toBeNull();
    expect(await ledgerRow(u.id, H2)).toMatchObject({ count: 1 });
    expect((await objectRow(u.id, H1))?.refCount).toBe(0);
    expect((await objectRow(u.id, H2))?.refCount).toBe(1);
  });

  it("置空头像（null）：账本行删除、ref_count 归零，同事务落库", async () => {
    const u = await setupUserWithObjects();
    await updateUser(u.id, { avatarKey: u.key1 });

    await updateUser(u.id, { avatarKey: null });

    expect(await ledgerRow(u.id, H1)).toBeNull();
    expect((await objectRow(u.id, H1))?.refCount).toBe(0);
    expect((await prisma!.user.findUnique({ where: { id: u.id } }))?.avatarKey).toBeNull();
  });

  it("白名单外字段（hashedPassword/role）被丢弃，theme 正常更新", async () => {
    const u = await setupUserWithObjects();

    const updated = await updateUser(u.id, {
      theme: "light",
      hashedPassword: "evil",
      role: "admin",
    } as Parameters<typeof updateUser>[1]);

    expect(updated.theme).toBe("light");
    expect(updated.hashedPassword).toBe("h");
    expect(updated.role).toBe("user");
    expect(await prisma!.fileRef.count({ where: { userId: u.id } })).toBe(0);
  });

  it("不更新 avatarKey 时账本零写入（theme-only）", async () => {
    const u = await setupUserWithObjects();

    await updateUser(u.id, { theme: "light" });

    expect(await prisma!.fileRef.count({ where: { userId: u.id } })).toBe(0);
    expect((await objectRow(u.id, H1))?.refCount).toBe(0);
  });

  it("外部 http(s) URL：产品值域仅存储 key，fail-closed 拒绝且零变更", async () => {
    const u = await setupUserWithObjects();
    await updateUser(u.id, { avatarKey: u.key1 });

    await expect(updateUser(u.id, { avatarKey: "https://example.com/a.png" })).rejects.toBeInstanceOf(
      UserAvatarKeyError,
    );

    expect((await prisma!.user.findUnique({ where: { id: u.id } }))?.avatarKey).toBe(u.key1);
    expect(await ledgerRow(u.id, H1)).toMatchObject({ count: 1 });
    expect((await objectRow(u.id, H1))?.refCount).toBe(1);
  });

  it("非值域形态 fail-closed：抛 UserAvatarKeyError，事务回滚用户行与账本零变更", async () => {
    const u = await setupUserWithObjects();
    await updateUser(u.id, { avatarKey: u.key1 });

    await expect(updateUser(u.id, { avatarKey: "javascript:alert(1)" })).rejects.toBeInstanceOf(
      UserAvatarKeyError,
    );

    expect((await prisma!.user.findUnique({ where: { id: u.id } }))?.avatarKey).toBe(u.key1);
    expect(await ledgerRow(u.id, H1)).toMatchObject({ count: 1 });
    expect((await objectRow(u.id, H1))?.refCount).toBe(1);
  });

  it("他人命名空间 key（内嵌属主 ≠ 当前用户）：fail-closed 拒绝且零变更", async () => {
    const u = await setupUserWithObjects();
    await updateUser(u.id, { avatarKey: u.key1 });

    const [, pair, hash] = u.key1.split("/");
    const foreignKey = `999/${pair}/${hash}`;
    await expect(updateUser(u.id, { avatarKey: foreignKey })).rejects.toBeInstanceOf(
      UserAvatarKeyError,
    );

    expect((await prisma!.user.findUnique({ where: { id: u.id } }))?.avatarKey).toBe(u.key1);
    expect(await ledgerRow(u.id, H1)).toMatchObject({ count: 1 });
  });

  it("key 形态合法但对象行缺失：fail-closed 拒绝，不造 GC 不可见惰性聚合行", async () => {
    const u = await setupUserWithObjects();
    const ghostHash = "d".repeat(64);
    const ghostKey = `${u.id}/${ghostHash.slice(0, 2)}/${ghostHash}.png`;

    await expect(updateUser(u.id, { avatarKey: ghostKey })).rejects.toBeInstanceOf(
      UserAvatarKeyError,
    );

    // 事务整体回滚：user 行未落 ghost key，账本零写入
    expect((await prisma!.user.findUnique({ where: { id: u.id } }))?.avatarKey).toBeNull();
    expect(await prisma!.fileRef.count({ where: { userId: u.id } })).toBe(0);
  });
});

describe.skipIf(!databaseTestsEnabled)("存量回填迁移 × 运行时判别交叉验证（20261018160000）", () => {
  const migrationSql = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../../prisma/migrations/20261018160000_avatar_ref_ledger_backfill/migration.sql"),
    "utf-8",
  );

  /** 造用户（avatar 原文入库）+ 可选对象行/既有账本行 → 跑迁移 → 返回该 hash 的账本行与聚合 */
  async function backfill(avatar: string, opts: { withObject?: boolean; staleHash?: string } = {}) {
    const user = await prisma!.user.create({
      data: { username: `mig-${Date.now()}-${Math.random()}`, hashedPassword: "h", avatarKey: avatar },
    });
    const hash = hashFromStorageKey(avatar);
    if (opts.withObject && hash) {
      await prisma!.fileObject.create({
        data: {
          userId: user.id, hash, size: 10,
          ext: avatar.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "",
          mimeType: "", refCount: 0,
        },
      });
    }
    if (opts.staleHash) {
      await prisma!.fileRef.create({
        data: { userId: user.id, sourceType: "avatar", sourceId: String(user.id), hash: opts.staleHash, count: 1 },
      });
    }

    await prisma!.$executeRawUnsafe(migrationSql);

    const row = hash
      ? await prisma!.fileRef.findFirst({ where: { userId: user.id, sourceType: "avatar", hash } })
      : null;
    const obj = hash
      ? await prisma!.fileObject.findUnique({ where: { userId_hash: { userId: user.id, hash } } })
      : null;
    const allRows = await prisma!.fileRef.findMany({ where: { userId: user.id, sourceType: "avatar" } });
    return { user, hash, row, allRows, refCount: obj?.refCount };
  }

  it("有扩展名 key + 对象在位：SQL 登记结果与 hashFromStorageKey 期望一致", async () => {
    const { hash, row, refCount } = await backfill(
      "1/ad/addc5abd0597a11c21f2c29fa4ec27010b2b253fad01fc5de4a4cef23dcb43f8.png",
      { withObject: true },
    );
    expect(hash).toBe("addc5abd0597a11c21f2c29fa4ec27010b2b253fad01fc5de4a4cef23dcb43f8");
    expect(row).toMatchObject({ count: 1 });
    expect(refCount).toBe(1);
  });

  it("无扩展名 key（canonical 允许）：迁移与运行时同口径登记", async () => {
    const { row, refCount } = await backfill(`2/${H1.slice(0, 2)}/${H1}`, { withObject: true });
    expect(row).toMatchObject({ count: 1 });
    expect(refCount).toBe(1);
  });

  it("超长扩展名（>8 位，前版正则漏登记处）：迁移与运行时同口径登记", async () => {
    const { row, refCount } = await backfill(`3/${H2.slice(0, 2)}/${H2}.abcdefghi`, { withObject: true });
    expect(row).toMatchObject({ count: 1 });
    expect(refCount).toBe(1);
  });

  it("外部 URL：运行时判 null 不登记，迁移同口径跳过", async () => {
    const { allRows } = await backfill("https://example.com/a.png", { withObject: true });
    expect(allRows).toEqual([]);
  });

  it("key 形态但对象行缺失：跳过登记（不造幽灵账本行）", async () => {
    const { allRows } = await backfill(`4/${H1.slice(0, 2)}/${H1}.png`);
    expect(allRows).toEqual([]);
  });

  it("已有旧行（异 hash）：每用户守卫跳过，旧行保留待运行时自愈", async () => {
    const stale = "c".repeat(64);
    const { allRows, refCount } = await backfill(`5/${H2.slice(0, 2)}/${H2}.png`, {
      withObject: true,
      staleHash: stale,
    });
    expect(allRows).toHaveLength(1);
    expect(allRows[0].hash).toBe(stale);
    expect(refCount).toBe(0);
  });
});
