/**
 * runStorageGc 直测（mock prisma，契约级）：
 * 锁定候选池 SQL 形态（三类排除 + FIFO + LIMIT）、排除量上报、
 * dry-run 只列不删、事务终检三态（回收/引用回归/账本新行）；
 * runGcCycle 三阶段独立成败（引用回收 / staging 清扫 / 派生清扫互不拖累）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  fileObjectDelete: vi.fn(),
  stat: vi.fn(),
  del: vi.fn(),
  sweepStaging: vi.fn(),
  sweepDerived: vi.fn(),
  getConfig: vi.fn().mockReturnValue({ LOG_LEVEL: "silent" }),
}));

vi.mock("@server/services/storage/upload-direct", () => ({
  sweepStagingObjects: mocks.sweepStaging,
}));
vi.mock("@server/services/storage/derived-cleanup", () => ({
  sweepStaleDerivedObjects: mocks.sweepDerived,
}));

vi.mock("@server/core/database/client", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    $transaction: mocks.transaction,
    fileObject: {
      delete: mocks.fileObjectDelete,
    },
  },
}));

vi.mock("@server/core/config", () => ({ getConfig: mocks.getConfig }));
vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());
vi.mock("@server/services/storage/service", async () => ({
  ...(await vi.importActual("@server/services/storage/service")),
  getStorageBackend: () => ({ delete: mocks.del, stat: mocks.stat }),
}));

import type { Prisma } from "@server/core/database/generated/client";
import { runGcCycle, runStorageGc } from "@server/services/storage/gc";
import { resetTestSettings } from "../../helpers/settings";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const row = (hash: string, overrides: Record<string, unknown> = {}) => ({
  user_id: 3,
  hash,
  size: 100n,
  ext: ".png",
  ...overrides,
});

const ZERO_COUNTS = { unlocatable: 0n, ledger_protected: 0n, agent_protected: 0n };

/** $queryRaw 按调用序分发：第 1 次=候选页，第 2 次=排除量统计 */
function setRawResponses(rows: unknown[], counts: Record<string, bigint> = ZERO_COUNTS): void {
  mocks.queryRaw.mockReset();
  let call = 0;
  mocks.queryRaw.mockImplementation(async () => {
    call += 1;
    return call === 1 ? rows : [counts];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConfig.mockReturnValue({ LOG_LEVEL: "silent" });
  resetTestSettings({ "storage.gc_dry_run": true });
  setRawResponses([]);
  mocks.stat.mockResolvedValue(null);
  mocks.del.mockResolvedValue(undefined);
});

describe("runStorageGc 候选池与上报", () => {
  it("无候选时返回空报告", async () => {
    const report = await runStorageGc();
    expect(report.candidates).toBe(0);
    expect(report.reclaimed).toEqual([]);
  });

  it("候选池 SQL：三类排除 + FIFO 升序 + 批上限参数化", async () => {
    await runStorageGc();
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    const sql = mocks.queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).toContain("fo.ext LIKE '.%'");
    expect(sql.text).toContain("NOT EXISTS (SELECT 1 FROM file_refs fr");
    expect(sql.text).toContain("NOT EXISTS (SELECT 1 FROM agent_messages am");
    expect(sql.text).toContain("ORDER BY fo.updated_at ASC");
    expect(sql.text).toContain("LIMIT");
    expect(sql.values).toEqual([expect.any(Date), 500]);
  });

  it("排除量统计与候选查询同一 WHERE 前置条件，三类计数照常上报", async () => {
    setRawResponses(
      [row(HASH_A)],
      { unlocatable: 1n, ledger_protected: 2n, agent_protected: 3n },
    );

    const report = await runStorageGc();
    expect(report.candidates).toBe(1);
    expect(report.unlocatable).toBe(1);
    expect(report.ledgerProtected).toBe(2);
    expect(report.agentProtected).toBe(3);
    const countSql = mocks.queryRaw.mock.calls[1][0] as Prisma.Sql;
    expect(countSql.text).toContain("COUNT(*) FILTER");
    expect(countSql.text).toContain("ref_count <= 0");
  });

  it("dry-run 只列出将回收项，不删行不删文件", async () => {
    setRawResponses([row(HASH_A)]);

    const report = await runStorageGc();
    expect(report.dryRun).toBe(true);
    expect(report.reclaimed).toEqual([
      { userId: 3, hash: HASH_A, key: `3/${HASH_A.slice(0, 2)}/${HASH_A}.png`, size: 100 },
    ]);
    expect(mocks.fileObjectDelete).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });
});

describe("runStorageGc 实删", () => {
  beforeEach(() => {
    resetTestSettings({ "storage.gc_dry_run": false });
  });

  it("终检通过：删行后删文件，计入回收", async () => {
    setRawResponses([row(HASH_A)]);
    mocks.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<boolean>) =>
      cb({
        fileObject: {
          findUnique: vi.fn().mockResolvedValue({ refCount: 0 }),
          delete: mocks.fileObjectDelete.mockResolvedValue({}),
        },
        fileRef: { findFirst: vi.fn().mockResolvedValue(null) },
      }),
    );

    const report = await runStorageGc();
    expect(mocks.fileObjectDelete).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledWith(`3/${HASH_A.slice(0, 2)}/${HASH_A}.png`);
    expect(report.skipped).toBe(0);
    expect(report.reclaimed).toHaveLength(1);
  });

  it("终检发现引用已回来：放弃回收，保留行", async () => {
    setRawResponses([row(HASH_A)]);
    mocks.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<boolean>) =>
      cb({
        fileObject: {
          findUnique: vi.fn().mockResolvedValue({ refCount: 1 }),
          delete: mocks.fileObjectDelete,
        },
        fileRef: { findFirst: vi.fn().mockResolvedValue(null) },
      }),
    );

    const report = await runStorageGc();
    expect(mocks.fileObjectDelete).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
    expect(report.skipped).toBe(1);
  });

  it("终检发现账本出现新行：放弃回收，保留行", async () => {
    setRawResponses([row(HASH_A)]);
    mocks.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<boolean>) =>
      cb({
        fileObject: {
          findUnique: vi.fn().mockResolvedValue({ refCount: 0 }),
          delete: mocks.fileObjectDelete,
        },
        fileRef: { findFirst: vi.fn().mockResolvedValue({ id: 1 }) },
      }),
    );

    const report = await runStorageGc();
    expect(mocks.fileObjectDelete).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
    expect(report.skipped).toBe(1);
  });

  it("多个候选逐一处理，互不影响", async () => {
    setRawResponses([row(HASH_A), row(HASH_B)]);
    let call = 0;
    mocks.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<boolean>) => {
      call += 1;
      const refCount = call === 1 ? 0 : 1; // 第二个候选引用已回来
      return cb({
        fileObject: {
          findUnique: vi.fn().mockResolvedValue({ refCount }),
          delete: mocks.fileObjectDelete.mockResolvedValue({}),
        },
        fileRef: { findFirst: vi.fn().mockResolvedValue(null) },
      });
    });

    const report = await runStorageGc();
    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(report.skipped).toBe(1);
    // 实删失败的候选不计入 reclaimed（reclaimed 只含真正回收成功的条目）
    expect(report.reclaimed).toHaveLength(1);
  });
});

describe("runGcCycle 三阶段独立成败（specs/derived-deletion-linkage.md 规则 4）", () => {
  beforeEach(() => {
    mocks.sweepStaging.mockResolvedValue(0);
    mocks.sweepDerived.mockResolvedValue(0);
  });

  it("引用回收失败不拖累两路清扫", async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockRejectedValue(new Error("db down"));
    mocks.sweepStaging.mockResolvedValue(2);
    mocks.sweepDerived.mockResolvedValue(5);

    await expect(runGcCycle()).resolves.toEqual({
      gc: null,
      gcError: expect.stringContaining("db down"),
      swept: 2,
      sweepError: null,
      derivedSwept: 5,
      derivedSweepError: null,
    });
  });

  it("staging 清扫失败不拖累引用回收与派生清扫", async () => {
    setRawResponses([]);
    mocks.sweepStaging.mockRejectedValue(new Error("s3 down"));
    mocks.sweepDerived.mockResolvedValue(5);

    const result = await runGcCycle();
    expect(result.gc).not.toBeNull();
    expect(result.swept).toBeNull();
    expect(result.sweepError).toContain("s3 down");
    expect(result.derivedSwept).toBe(5);
    expect(result.derivedSweepError).toBeNull();
  });

  it("派生清扫失败独立记录，不拖累前两阶段", async () => {
    setRawResponses([]);
    mocks.sweepStaging.mockResolvedValue(1);
    mocks.sweepDerived.mockRejectedValue(new Error("list failed"));

    const result = await runGcCycle();
    expect(result.gc).not.toBeNull();
    expect(result.swept).toBe(1);
    expect(result.derivedSwept).toBeNull();
    expect(result.derivedSweepError).toContain("list failed");
  });
});
