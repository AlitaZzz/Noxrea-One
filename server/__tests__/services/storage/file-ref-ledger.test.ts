/**
 * 文件引用账本单元测试。
 * 用内存版事务客户端锁定账本编排语义：差量整替、数量归一、行级增删、
 * 聚合计数差量（账本↔ref_count 一致性的关键不变量）、批量分块。
 * adjustFileRefCount 被 mock 并记录调用，断言聚合计数收到正确的增减量。
 */
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const adjustCalls = vi.hoisted(() => ({
  calls: [] as Array<{ userId: number; hash: string; delta: number }>,
}));

vi.mock("@server/crud/file", () => ({
  adjustFileRefCount: async (
    _tx: unknown,
    userId: number,
    hash: string,
    delta: number,
  ) => {
    adjustCalls.calls.push({ userId, hash, delta });
  },
}));

import {
  removeSourceFileRefs,
  removeSourceFileRefsBatch,
  replaceSourceFileRefs,
} from "@server/services/storage/file-ref-ledger";

interface LedgerRow {
  id: number;
  userId: number;
  sourceType: string;
  sourceId: string;
  hash: string;
  count: number;
}

type FindWhere = {
  userId: number;
  sourceType: string;
  sourceId?: string;
  hash?: string;
};

function matches(
  row: LedgerRow,
  where: FindWhere,
): boolean {
  if (row.userId !== where.userId || row.sourceType !== where.sourceType) return false;
  if (where.hash !== undefined && row.hash !== where.hash) return false;
  if (where.sourceId === undefined) return true;
  return row.sourceId === where.sourceId;
}

/** 内存版 fileRef 表 + 满足 TransactionClient 形参的事务客户端 */
function makeTx() {
  const rows: LedgerRow[] = [];
  let nextId = 1;
  const fileRef = {
    findMany: vi.fn(async ({ where }: { where: FindWhere }) =>
      rows.filter((r) => matches(r, where)),
    ),
    upsert: vi.fn(async ({
      where,
      update,
      create,
    }: {
      where: { sourceType_sourceId_hash: { sourceType: string; sourceId: string; hash: string } };
      update: { count: number };
      create: Omit<LedgerRow, "id">;
    }) => {
      const found = rows.find(
        (r) =>
          r.sourceType === where.sourceType_sourceId_hash.sourceType &&
          r.sourceId === where.sourceType_sourceId_hash.sourceId &&
          r.hash === where.sourceType_sourceId_hash.hash,
      );
      if (found) {
        found.count = update.count;
        return found;
      }
      const row: LedgerRow = { id: nextId++, ...create };
      rows.push(row);
      return row;
    }),
    deleteMany: vi.fn(async ({ where }: { where: FindWhere }) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i], where)) rows.splice(i, 1);
      }
      return { count: before - rows.length };
    }),
    $executeRaw: vi.fn(async () => 0),
  };
  const tx = { fileRef, $executeRaw: fileRef.$executeRaw } as unknown as Prisma.TransactionClient;
  return { rows, fileRef, tx };
}

const source = { userId: 1, sourceType: "canvas" as const, sourceId: "p1" };

beforeEach(() => {
  adjustCalls.calls = [];
});

describe("replaceSourceFileRefs", () => {
  it("全新来源：按期望数量建行并正向调整聚合", async () => {
    const { rows, tx } = makeTx();
    await replaceSourceFileRefs(tx, source, new Map([["a", 2], ["b", 1]]));

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.hash === "a")?.count).toBe(2);
    expect(rows.find((r) => r.hash === "b")?.count).toBe(1);
    expect(adjustCalls.calls).toEqual([
      { userId: 1, hash: "a", delta: 2 },
      { userId: 1, hash: "b", delta: 1 },
    ]);
  });

  it("整替差量：增/减/清零各自落到聚合计数与行状态", async () => {
    const { rows, tx } = makeTx();
    await replaceSourceFileRefs(tx, source, new Map([["a", 2], ["b", 1]]));
    adjustCalls.calls = [];

    await replaceSourceFileRefs(tx, source, new Map([["a", 1], ["c", 3]]));

    // a: 2→1 减 1；b: 1→0 删行并减 1；c: 0→3 增 3
    expect(adjustCalls.calls).toEqual([
      { userId: 1, hash: "a", delta: -1 },
      { userId: 1, hash: "b", delta: -1 },
      { userId: 1, hash: "c", delta: 3 },
    ]);
    expect(rows.find((r) => r.hash === "a")?.count).toBe(1);
    expect(rows.find((r) => r.hash === "b")).toBeUndefined();
    expect(rows.find((r) => r.hash === "c")?.count).toBe(3);
  });

  it("数量规整：空 hash 与非正数量被过滤，不产生行与聚合变更", async () => {
    const { rows, tx } = makeTx();
    await replaceSourceFileRefs(tx, source, new Map([["", 3], ["a", 0], ["b", -2], ["c", 1]]));

    expect(rows.map((r) => r.hash)).toEqual(["c"]);
    expect(adjustCalls.calls).toEqual([{ userId: 1, hash: "c", delta: 1 }]);
  });

  it("引用集合不变时零聚合写入（布局保存不触发账本写入的前提）", async () => {
    const { tx } = makeTx();
    await replaceSourceFileRefs(tx, source, new Map([["a", 2]]));
    adjustCalls.calls = [];

    await replaceSourceFileRefs(tx, source, new Map([["a", 2]]));

    expect(adjustCalls.calls).toEqual([]);
  });

  it("多来源互不干扰：同 hash 不同来源各自持账", async () => {
    const { rows, tx } = makeTx();
    await replaceSourceFileRefs(tx, source, new Map([["a", 1]]));
    await replaceSourceFileRefs(tx, { ...source, sourceId: "p2" }, new Map([["a", 3]]));

    const aRows = rows.filter((r) => r.hash === "a");
    expect(aRows).toHaveLength(2);
    expect(adjustCalls.calls.filter((c) => c.hash === "a").reduce((s, c) => s + c.delta, 0)).toBe(4);
  });
});

describe("removeSourceFileRefs", () => {
  it("按行数量负向调整并清空该来源账本", async () => {
    const { rows, tx } = makeTx();
    await replaceSourceFileRefs(tx, source, new Map([["a", 2], ["b", 1]]));
    adjustCalls.calls = [];

    await removeSourceFileRefs(tx, source);

    expect(adjustCalls.calls).toEqual([
      { userId: 1, hash: "a", delta: -2 },
      { userId: 1, hash: "b", delta: -1 },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("空来源无操作", async () => {
    const { rows, tx } = makeTx();
    await removeSourceFileRefs(tx, source);
    expect(adjustCalls.calls).toEqual([]);
    expect(rows).toHaveLength(0);
  });
});

describe("removeSourceFileRefsBatch", () => {
  it("空来源列表直接返回，不触发任何 SQL", async () => {
    const { fileRef, tx } = makeTx();
    await removeSourceFileRefsBatch(tx, { userId: 1, sourceType: "canvas", sourceIds: [] });
    expect(fileRef.$executeRaw).not.toHaveBeenCalled();
  });
  // 语义与规模回归在真实 SQLite 库上验证（$executeRaw 无法在内存 mock 上验证）：
  // 见 file-ref-ledger-bulk.test.ts
});
