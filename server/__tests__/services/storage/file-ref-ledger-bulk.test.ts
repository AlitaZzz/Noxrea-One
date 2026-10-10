/**
 * 文件引用账本批量移除的真实库回归测试。
 *
 * removeSourceFileRefsBatch 已改为集合运算 SQL（聚合 UPDATE ... FROM + 分片 DELETE），
 * $executeRaw 无法在内存 mock 上验证，语义与规模必须在真实 SQLite 库上锁定：
 * - 语义：同 hash 多来源合并递减、缺失 file_objects 行跳过、归零保留、账本行清空。
 * - 规模：5 万来源在 Prisma 默认 5s 交互式事务预算内完成（曾实测逐 hash 循环在此规模 P2028 回滚）。
 */
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dbPath = path.join(os.tmpdir(), `noxrea-ledger-bulk-${process.pid}.db`);
const dbUrl = "file:" + dbPath.replace(/\\/g, "/");

let prisma: PrismaClient | null = null;
let removeSourceFileRefsBatch: typeof import("@server/services/storage/file-ref-ledger").removeSourceFileRefsBatch = null!;
let savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // 保存并最终恢复被本测试改写的环境，避免污染同 worker 的后续测试文件
  savedEnv = { DATABASE_URL: process.env.DATABASE_URL, LOG_LEVEL: process.env.LOG_LEVEL };
  process.env.DATABASE_URL = dbUrl;
  process.env.LOG_LEVEL = "ERROR";
  // 环境变量就位后才能实例化客户端（连接串在构造时读取）
  const client = await import("@server/core/database/client");
  const ledger = await import("@server/services/storage/file-ref-ledger");
  prisma = client.prisma;
  removeSourceFileRefsBatch = ledger.removeSourceFileRefsBatch;

  execSync("npx prisma db push --skip-generate", {
    // storage → services → __tests__ → server → 仓库根
    cwd: path.resolve(import.meta.dirname ?? ".", "../../../.."),
    env: { ...process.env },
    stdio: "pipe",
  });
  // 与生产启动一致：WAL + busy_timeout，否则写事务耗时显著高于生产路径
  await client.applyPragmas();
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* Windows 句柄延迟释放 */ }
  }
  process.env.DATABASE_URL = savedEnv.DATABASE_URL;
  process.env.LOG_LEVEL = savedEnv.LOG_LEVEL;
});

describe("removeSourceFileRefsBatch（真实 SQLite 库）", () => {
  it("多来源同 hash 合并递减、缺失聚合行跳过、账本行清空", async () => {
    // hash a：两个来源共 3 个引用，file_objects 行存在 → 递减到 0（归零保留）
    // hash b：来源行存在但 file_objects 缺失 → 跳过不报错
    await prisma!.fileObject.createMany({ data: [{ userId: 1, hash: "a", refCount: 3, size: 1 }] });
    await prisma!.fileRef.createMany({ data: [
      { userId: 1, sourceType: "canvas", sourceId: "p1", hash: "a", count: 2 },
      { userId: 1, sourceType: "canvas", sourceId: "p2", hash: "a", count: 1 },
      { userId: 1, sourceType: "canvas", sourceId: "p1", hash: "b", count: 1 },
    ] });

    await prisma!.$transaction((tx: Prisma.TransactionClient) =>
      removeSourceFileRefsBatch(tx, { userId: 1, sourceType: "canvas", sourceIds: ["p1", "p2"] }),
    );

    expect(await prisma!.fileRef.count({ where: { userId: 1 } })).toBe(0);
    expect(await prisma!.fileObject.findUnique({ where: { userId_hash: { userId: 1, hash: "a" } } }))
      .toMatchObject({ refCount: 0 });
    expect(await prisma!.fileObject.count({ where: { userId: 1, refCount: { lt: 0 } } })).toBe(0);
  });

  it("空来源列表无操作", async () => {
    await prisma!.$transaction((tx: Prisma.TransactionClient) =>
      removeSourceFileRefsBatch(tx, { userId: 1, sourceType: "canvas", sourceIds: [] }),
    );
    expect(await prisma!.fileRef.count({ where: { userId: 1 } })).toBe(0);
  });

  it("5 万来源在默认 5s 事务预算内完成（逐 hash 循环在此规模曾 P2028 回滚）", async () => {
    const N = 50_000;
    for (let offset = 0; offset < N; offset += 5000) {
      const pairs = Array.from({ length: 5000 }, (_, i) => {
        const hash = String(offset + i).padStart(6, "0").padEnd(64, "a");
        return { hash };
      });
      await prisma!.fileObject.createMany({
        data: pairs.map((p) => ({ userId: 1, hash: p.hash, refCount: 1, size: 1 })),
      });
      await prisma!.fileRef.createMany({
        data: pairs.map((p, i) => ({
          userId: 1, sourceType: "asset_item",
          sourceId: String(offset + i + 1), hash: p.hash,
        })),
      });
    }
    const sourceIds = Array.from({ length: N }, (_, i) => String(i + 1));

    // 完成本身即断言：默认 5s 事务预算内不触发 P2028；显式计时代防逐步漂移
    const t0 = performance.now();
    await prisma!.$transaction((tx: Prisma.TransactionClient) =>
      removeSourceFileRefsBatch(tx, { userId: 1, sourceType: "asset_item", sourceIds }),
    );
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(5000);
    console.log(`[ledger-bulk] 5 万来源移除事务耗时 ${elapsedMs.toFixed(0)}ms`);

    expect(await prisma!.fileRef.count({ where: { userId: 1, sourceType: "asset_item" } })).toBe(0);
    expect(await prisma!.fileObject.count({ where: { userId: 1, refCount: { not: 0 } } })).toBe(0);
    expect(await prisma!.fileObject.count({ where: { userId: 1, refCount: { lt: 0 } } })).toBe(0);
  }, 30_000);
});
