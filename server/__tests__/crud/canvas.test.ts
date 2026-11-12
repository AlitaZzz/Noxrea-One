import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  directFindFirst: vi.fn(),
  directFindMany: vi.fn(),
  removeSourceFileRefsTx: vi.fn(),
}));

vi.mock("@server/core/database/client", () => ({
  prisma: {
    // 事务外的直读（存在性探测、当前版本）
    canvasProject: { findFirst: mocks.directFindFirst, findMany: mocks.directFindMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@server/crud/file-ref-ledger", () => ({
  removeSourceFileRefsTx: mocks.removeSourceFileRefsTx,
}));

import { Prisma } from "@server/core/database/generated/client";
import {
  createProject,
  deleteProject,
  getProject,
  getProjectRevision,
  getProjectRowForWriteTx,
  getProjects,
  projectExists,
  updateProjectRowTx,
} from "@server/crud/canvas";
import { stringifyJson } from "@server/crud/json-column";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const key = (hash: string) => `1/${hash.slice(0, 2)}/${hash}.png`;
const TX = {
  $queryRaw: async () => [],
  canvasProject: {
    findFirst: mocks.findFirst,
    create: mocks.create,
    update: mocks.update,
    deleteMany: mocks.deleteMany,
  },
};

const writeRow = {
  id: "p1",
  revision: 3,
  canvasData: { nodes: [{ type: "image-node", data: { src: key(HASH_A) } }] },
  coverKey: null,
};

/** 带品牌的行只能由事务内 getter 产生：测试同样走真实读取原语，不伪造入参 */
async function readWriteRow() {
  const row = await getProjectRowForWriteTx(TX as never, "p1", 1);
  if (!row) throw new Error("write row fixture missing");
  return row;
}

/**
 * 有状态假事务：项目行与账本引用都存在这里，事务回调抛错时恢复快照，
 * 这样「整体回滚」才是被断言的语义，而不是把回调直接放行的空壳。
 */
interface FakeState {
  projects: Map<string, Record<string, unknown>>;
  ledger: Map<string, Map<string, number>>;
}

let state: FakeState;

const refKey = (source: { sourceType: string; sourceId: string }) => `${source.sourceType}:${source.sourceId}`;

function seedProject(id: string, userId: number): void {
  state.projects.set(id, {
    id, userId, name: "P", revision: 1, canvasData: stringifyJson({}), nodeCount: 0,
    thumbnailSrc: null, coverKey: null, createdAt: new Date(0), updatedAt: new Date(0),
  });
}

function seedLedger(sourceType: string, sourceId: string): void {
  state.ledger.set(`${sourceType}:${sourceId}`, new Map([[HASH_A, 1]]));
}

function snapshotState(): FakeState {
  return {
    projects: new Map([...state.projects].map(([id, row]) => [id, { ...row }])),
    ledger: new Map([...state.ledger].map(([ref, counts]) => [ref, new Map(counts)])),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state = { projects: new Map(), ledger: new Map() };
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const before = snapshotState();
    try {
      return await fn(TX);
    } catch (error) {
      state = before;
      throw error;
    }
  });
  mocks.directFindFirst.mockResolvedValue({ id: "p1", revision: 3 });
  mocks.directFindMany.mockResolvedValue([]);
  mocks.findFirst.mockResolvedValue({ ...writeRow, canvasData: stringifyJson(writeRow.canvasData) });
  mocks.update.mockResolvedValue({ ...writeRow, revision: 4, canvasData: stringifyJson(writeRow.canvasData) });
  mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const row = {
      id: data.id as string,
      userId: data.userId as number,
      name: data.name as string,
      revision: 1,
      canvasData: data.canvasData as string,
      nodeCount: data.nodeCount as number,
      thumbnailSrc: (data.thumbnailSrc ?? null) as string | null,
      coverKey: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    state.projects.set(row.id, { ...row });
    return row;
  });
  mocks.deleteMany.mockImplementation(async ({ where }: { where: { id: string; userId: number } }) => {
    const row = state.projects.get(where.id);
    if (!row || row.userId !== where.userId) return { count: 0 };
    state.projects.delete(where.id);
    return { count: 1 };
  });
  mocks.removeSourceFileRefsTx.mockImplementation(
    async (_tx: unknown, source: { sourceType: string; sourceId: string }) => {
      state.ledger.delete(refKey(source));
    },
  );
});

describe("读操作", () => {
  it("getProjects 只读摘要投影，并按 coverKey 优先返回 thumbnail", async () => {
    const updatedAt = new Date("2026-01-01");
    mocks.directFindMany.mockResolvedValue([
      { id: "p1", name: "A", revision: 2, updatedAt, coverKey: key(HASH_B), nodeCount: 4, thumbnailSrc: key(HASH_A) },
      { id: "p2", name: "B", revision: 1, updatedAt, coverKey: null, nodeCount: 0, thumbnailSrc: null },
    ]);

    await expect(getProjects(1)).resolves.toEqual([
      { id: "p1", name: "A", revision: 2, updatedAt, thumbnail: key(HASH_B), coverKey: key(HASH_B), nodeCount: 4 },
      { id: "p2", name: "B", revision: 1, updatedAt, thumbnail: null, coverKey: null, nodeCount: 0 },
    ]);
    expect(mocks.directFindMany).toHaveBeenCalledWith({
      where: { userId: 1 },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true, name: true, revision: true, updatedAt: true,
        coverKey: true, nodeCount: true, thumbnailSrc: true,
      },
    });
  });

  it("getProject 解析 canvasData；不存在返回 null", async () => {
    mocks.directFindFirst.mockResolvedValue({ ...writeRow, canvasData: stringifyJson(writeRow.canvasData) });

    await expect(getProject("p1", 1)).resolves.toMatchObject({
      id: "p1",
      canvasData: writeRow.canvasData,
    });

    mocks.directFindFirst.mockResolvedValue(null);
    await expect(getProject("p1", 1)).resolves.toBeNull();
  });

  it("projectExists 只查存在性", async () => {
    mocks.directFindFirst.mockResolvedValue({ id: "p1" });
    await expect(projectExists("p1", 1)).resolves.toBe(true);

    mocks.directFindFirst.mockResolvedValue(null);
    await expect(projectExists("p1", 1)).resolves.toBe(false);

    expect(mocks.directFindFirst).toHaveBeenCalledWith({ where: { id: "p1", userId: 1 }, select: { id: true } });
  });

  it("getProjectRevision 只读 revision 列", async () => {
    await expect(getProjectRevision("p1", 1)).resolves.toBe(3);
    expect(mocks.directFindFirst).toHaveBeenCalledWith({ where: { id: "p1", userId: 1 }, select: { revision: true } });

    mocks.directFindFirst.mockResolvedValue(null);
    await expect(getProjectRevision("p1", 1)).resolves.toBeNull();
  });
});

describe("createProject", () => {
  it("只创建空画布：写入空文档与空摘要，不产生账本写入", async () => {
    const result = await createProject(1, { name: "New" });

    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        userId: 1,
        name: "New",
        canvasData: stringifyJson({}),
        nodeCount: 0,
        thumbnailSrc: null,
      },
      // 创建响应不读画布内容：只选择项目摘要所需列
      select: {
        id: true,
        userId: true,
        name: true,
        revision: true,
        coverKey: true,
        nodeCount: true,
        thumbnailSrc: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    expect(state.projects.get(result.id)).toBeDefined();
    expect(state.ledger.size).toBe(0);
    expect(result).toMatchObject({ id: result.id, name: "New", nodeCount: 0, thumbnailSrc: null });
  });

  it("创建失败时不落库（事务整体回滚）", async () => {
    mocks.create.mockRejectedValue(new Error("insert failed"));

    await expect(createProject(1, { name: "New" })).rejects.toThrow("insert failed");
    expect(state.projects.size).toBe(0);
    expect(state.ledger.size).toBe(0);
  });
});

describe("getProjectRowForWriteTx", () => {
  it("按固定投影读取并解析 canvasData", async () => {
    await expect(getProjectRowForWriteTx(TX as never, "p1", 1)).resolves.toEqual(writeRow);

    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "p1", userId: 1 },
      select: { id: true, revision: true, canvasData: true, coverKey: true },
    });
  });

  it("行不存在返回 null", async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(getProjectRowForWriteTx(TX as never, "p1", 1)).resolves.toBeNull();
  });
});

describe("updateProjectRowTx（单表写入原语）", () => {
  it("只写 name：不递增 revision、不派生摘要", async () => {
    await updateProjectRowTx(TX as never, await readWriteRow(), { name: "renamed" });

    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { name: "renamed" } });
  });

  it("写 canvasData：派生摘要并以数据库原子递增 revision", async () => {
    const canvasData = { nodes: [{ type: "image-node", data: { src: key(HASH_B) } }, { type: "text-node" }] };

    const result = await updateProjectRowTx(TX as never, await readWriteRow(), { canvasData });

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: {
        canvasData: stringifyJson(canvasData),
        revision: { increment: 1 },
        nodeCount: 2,
        thumbnailSrc: key(HASH_B),
      },
    });
    expect(result?.canvasData).toEqual(writeRow.canvasData);
  });

  it("写 coverKey（含 null 清空）：原样写列，不递增 revision", async () => {
    const row = await readWriteRow();
    await updateProjectRowTx(TX as never, row, { coverKey: key(HASH_B) });
    expect(mocks.update).toHaveBeenLastCalledWith({ where: { id: "p1" }, data: { coverKey: key(HASH_B) } });

    await updateProjectRowTx(TX as never, row, { coverKey: null });
    expect(mocks.update).toHaveBeenLastCalledWith({ where: { id: "p1" }, data: { coverKey: null } });
  });

  it("组合补丁一次写入", async () => {
    const canvasData = { nodes: [] };
    await updateProjectRowTx(TX as never, await readWriteRow(), { name: "n", canvasData, coverKey: null });

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: {
        name: "n",
        canvasData: stringifyJson(canvasData),
        revision: { increment: 1 },
        nodeCount: 0,
        thumbnailSrc: null,
        coverKey: null,
      },
    });
  });

  it("P2025（事务内行被并发删除）映射为 null", async () => {
    mocks.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("record not found", { code: "P2025", clientVersion: "test" }),
    );

    await expect(updateProjectRowTx(TX as never, await readWriteRow(), { name: "x" })).resolves.toBeNull();
  });

  it("其它 Prisma 错误原样抛出", async () => {
    mocks.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("boom", { code: "P2002", clientVersion: "test" }),
    );

    await expect(updateProjectRowTx(TX as never, await readWriteRow(), { name: "x" })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("deleteProject", () => {
  it("先删除项目行，再清理 canvas 与 canvas_cover 两个来源（同一事务客户端）", async () => {
    seedProject("p1", 1);
    seedLedger("canvas", "p1");
    seedLedger("canvas_cover", "p1");

    await expect(deleteProject("p1", 1)).resolves.toEqual({ count: 1 });

    const sources = mocks.removeSourceFileRefsTx.mock.calls.map(
      (call: unknown[]) => (call[1] as { sourceType: string }).sourceType,
    );
    expect(sources).toEqual(["canvas", "canvas_cover"]);
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: "p1", userId: 1 } });
    // 行删除必须先于账本清理：并发的项目写会在行锁上等待并最终得到 P2025，
    // 不可能在清理之后插入新账本行。
    expect(mocks.deleteMany.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.removeSourceFileRefsTx.mock.invocationCallOrder[0]);
    expect(mocks.removeSourceFileRefsTx.mock.calls.every(([tx]) => tx === TX)).toBe(true);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(state.projects.has("p1")).toBe(false);
    expect(state.ledger.size).toBe(0);
  });

  it("项目行不存在时直接返回 0，不触碰账本", async () => {
    seedLedger("canvas", "p1");
    seedLedger("canvas_cover", "p1");

    await expect(deleteProject("p1", 1)).resolves.toEqual({ count: 0 });

    expect(mocks.removeSourceFileRefsTx).not.toHaveBeenCalled();
    expect([...state.ledger.keys()].sort()).toEqual(["canvas:p1", "canvas_cover:p1"]);
  });

  it("项目行删除失败时不触碰账本，整体回滚", async () => {
    seedProject("p1", 1);
    seedLedger("canvas", "p1");
    seedLedger("canvas_cover", "p1");
    mocks.deleteMany.mockRejectedValueOnce(new Error("delete failed"));

    await expect(deleteProject("p1", 1)).rejects.toThrow("delete failed");

    expect(mocks.removeSourceFileRefsTx).not.toHaveBeenCalled();
    expect(state.projects.has("p1")).toBe(true);
    expect([...state.ledger.keys()].sort()).toEqual(["canvas:p1", "canvas_cover:p1"]);
  });
});
