import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fileObjectFindMany: vi.fn(),
  fileRefFindMany: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  fileObjectDelete: vi.fn(),
  stat: vi.fn(),
  del: vi.fn(),
  getConfig: vi.fn().mockReturnValue({ LOG_LEVEL: "silent", GC_GRACE_HOURS: 48, GC_DRY_RUN: true }),
}));

vi.mock("@server/core/database/client", () => ({
  prisma: {
    fileObject: {
      findMany: mocks.fileObjectFindMany,
      delete: mocks.fileObjectDelete,
    },
    fileRef: {
      findMany: mocks.fileRefFindMany,
    },
    $queryRaw: mocks.queryRaw,
    $transaction: mocks.transaction,
  },
}));

vi.mock("@server/core/config", () => ({ getConfig: mocks.getConfig }));
vi.mock("@server/services/storage/backends/local", () => ({
  localStorage: {
    delete: mocks.del,
    stat: mocks.stat,
  },
}));

import { runStorageGc } from "./gc";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const candidate = (hash: string, overrides: Record<string, unknown> = {}) => ({
  userId: 3,
  hash,
  size: 100n,
  ext: ".png",
  refCount: 0,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConfig.mockReturnValue({ LOG_LEVEL: "silent", GC_GRACE_HOURS: 48, GC_DRY_RUN: true });
  mocks.fileObjectFindMany.mockResolvedValue([]);
  mocks.fileRefFindMany.mockResolvedValue([]);
  mocks.queryRaw.mockResolvedValue([{ n: 0 }]);
  mocks.stat.mockResolvedValue(null);
  mocks.del.mockResolvedValue(undefined);
});

describe("runStorageGc 扫描与护栏", () => {
  it("无候选时返回空报告", async () => {
    const report = await runStorageGc();
    expect(report.candidates).toBe(0);
    expect(report.reclaimed).toEqual([]);
  });

  it("账本仍有行的候选被保护，不进入回收清单", async () => {
    mocks.fileObjectFindMany.mockResolvedValue([candidate(HASH_A)]);
    mocks.fileRefFindMany.mockResolvedValue([{ userId: 3, hash: HASH_A }]);

    const report = await runStorageGc();
    expect(report.candidates).toBe(1);
    expect(report.ledgerProtected).toBe(1);
    expect(report.reclaimed).toEqual([]);
  });

  it("Agent 消息引用的候选被保护，不进入回收清单", async () => {
    mocks.fileObjectFindMany.mockResolvedValue([candidate(HASH_A)]);
    mocks.queryRaw.mockResolvedValue([{ n: 2 }]);

    const report = await runStorageGc();
    expect(report.agentProtected).toBe(1);
    expect(report.reclaimed).toEqual([]);
  });

  it("扩展名缺失的候选标记 unlocatable，保留行", async () => {
    mocks.fileObjectFindMany.mockResolvedValue([candidate(HASH_A, { ext: "" })]);

    const report = await runStorageGc();
    expect(report.unlocatable).toBe(1);
    expect(report.reclaimed).toEqual([]);
  });

  it("dry-run 只列出将回收项，不删行不删文件", async () => {
    mocks.fileObjectFindMany.mockResolvedValue([candidate(HASH_A)]);

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
    mocks.getConfig.mockReturnValue({ LOG_LEVEL: "silent", GC_GRACE_HOURS: 48, GC_DRY_RUN: false });
  });

  it("终检通过：删行后删文件，计入回收", async () => {
    mocks.fileObjectFindMany.mockResolvedValue([candidate(HASH_A)]);
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
    mocks.fileObjectFindMany.mockResolvedValue([candidate(HASH_A)]);
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
    mocks.fileObjectFindMany.mockResolvedValue([candidate(HASH_A)]);
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
    mocks.fileObjectFindMany.mockResolvedValue([candidate(HASH_A), candidate(HASH_B)]);
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
