/**
 * 画布写用例测试（specs/server-crud-service-boundary.md 第 2 节）。
 * 用真实租约临界区与纯函数，锁定：元数据写免门禁、内容写租约/版本双闸、
 * 封面严格解析、内容与封面账本的条件写入，以及行读写只经 crud 原语。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  getProjectRowForWriteTx: vi.fn(),
  updateProjectRowTx: vi.fn(),
  getProjectRevision: vi.fn(),
  replaceSourceFileRefsTx: vi.fn(),
  replaceSourceFileRefTx: vi.fn(),
}));

vi.mock("@server/core/database/transaction", () => ({
  withTransaction: mocks.withTransaction,
}));
vi.mock("@server/crud/canvas", () => ({
  getProjectRowForWriteTx: mocks.getProjectRowForWriteTx,
  updateProjectRowTx: mocks.updateProjectRowTx,
  getProjectRevision: mocks.getProjectRevision,
}));
vi.mock("@server/crud/file-ref-ledger", () => ({
  replaceSourceFileRefsTx: mocks.replaceSourceFileRefsTx,
  replaceSourceFileRefTx: mocks.replaceSourceFileRefTx,
}));

import { joinCanvasRoom, resetCanvasPresence } from "@server/services/canvas/editor-lease";
import {
  updateProject,
  updateProjectDelta,
  CanvasCoverKeyError,
  CanvasLeaseLostError,
  CanvasRevisionConflictError,
} from "@server/services/canvas/project-write";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const key = (hash: string) => `1/${hash.slice(0, 2)}/${hash}.png`;
const TX = { name: "tx" };

const row = {
  id: "p1",
  revision: 3,
  canvasData: { nodes: [{ data: { src: key(HASH_A) } }] },
  coverKey: null as string | null,
};

function updatedRow(patch: { name?: string; canvasData?: Record<string, unknown>; coverKey?: string | null }) {
  return {
    id: row.id,
    userId: 1,
    name: patch.name ?? "Demo",
    revision: patch.canvasData !== undefined ? row.revision + 1 : row.revision,
    canvasData: patch.canvasData ?? row.canvasData,
    nodeCount: 0,
    thumbnailSrc: null,
    coverKey: patch.coverKey !== undefined ? patch.coverKey : row.coverKey,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** 在项目 p1 的房间内取得真实租约令牌 */
function joinAs(sid = "A"): number {
  return joinCanvasRoom("p1", sid, () => {}).leaseToken;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCanvasPresence();
  mocks.withTransaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(TX));
  mocks.getProjectRowForWriteTx.mockResolvedValue({ ...row, canvasData: structuredClone(row.canvasData) });
  mocks.updateProjectRowTx.mockImplementation(
    async (_tx: unknown, current: typeof row, patch: Parameters<typeof updatedRow>[0]) => updatedRow(patch),
  );
  mocks.getProjectRevision.mockResolvedValue(row.revision);
});

describe("元数据写（改名 / 封面，免租约）", () => {
  it("纯改名：不进租约校验，只写 name 且不触碰账本", async () => {
    const result = await updateProject("p1", 1, { name: "renamed" });

    expect(mocks.getProjectRevision).not.toHaveBeenCalled();
    expect(mocks.getProjectRowForWriteTx).toHaveBeenCalledWith(TX, "p1", 1);
    expect(mocks.updateProjectRowTx).toHaveBeenCalledWith(TX, expect.objectContaining({ id: "p1" }), {
      name: "renamed",
      coverKey: undefined,
    });
    expect(mocks.replaceSourceFileRefsTx).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefTx).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: "p1", name: "renamed" });
  });

  it("设置封面：按 canvas_cover 来源登记，不写内容账本", async () => {
    await updateProject("p1", 1, { coverKey: key(HASH_B) });

    expect(mocks.updateProjectRowTx.mock.calls[0]![2]).toEqual({
      name: undefined,
      coverKey: key(HASH_B),
    });
    expect(mocks.replaceSourceFileRefsTx).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefTx).toHaveBeenCalledWith(
      TX,
      { userId: 1, sourceType: "canvas_cover", sourceId: "p1" },
      key(HASH_B),
    );
  });

  it("清除封面（null）：登记空引用，不解析 key", async () => {
    await updateProject("p1", 1, { coverKey: null });

    expect(mocks.replaceSourceFileRefTx).toHaveBeenCalledWith(
      TX,
      { userId: 1, sourceType: "canvas_cover", sourceId: "p1" },
      null,
    );
  });

  it("封面不是存储 key：写行前抛 CanvasCoverKeyError，零写入", async () => {
    await expect(updateProject("p1", 1, { coverKey: "https://evil.example/x.png" }))
      .rejects.toBeInstanceOf(CanvasCoverKeyError);

    expect(mocks.updateProjectRowTx).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefTx).not.toHaveBeenCalled();
  });

  it("项目不存在：返回 null，不写账本", async () => {
    mocks.getProjectRowForWriteTx.mockResolvedValue(null);

    await expect(updateProject("p1", 1, { coverKey: key(HASH_B) })).resolves.toBeNull();
    expect(mocks.updateProjectRowTx).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefTx).not.toHaveBeenCalled();
  });
});

describe("内容写（租约 + 版本双闸）", () => {
  it("合法保存：写入 name/canvasData，引用集合变化时重算内容账本", async () => {
    const canvasData = { nodes: [{ data: { src: key(HASH_B) } }] };

    const result = await updateProject(
      "p1",
      1,
      { name: "saved", canvasData },
      { baseRevision: 3, lease: joinAs() },
    );

    expect(mocks.updateProjectRowTx).toHaveBeenCalledWith(TX, expect.objectContaining({ id: "p1" }), {
      name: "saved",
      canvasData,
      coverKey: undefined,
    });
    expect(mocks.replaceSourceFileRefsTx).toHaveBeenCalledTimes(1);
    const [, source, counts] = mocks.replaceSourceFileRefsTx.mock.calls[0] as unknown as [
      unknown,
      { sourceType: string; sourceId: string },
      Map<string, number>,
    ];
    expect(source).toMatchObject({ sourceType: "canvas", sourceId: "p1" });
    expect(Object.fromEntries(counts)).toEqual({ [HASH_B]: 1 });
    expect(result).toMatchObject({ id: "p1", revision: 4 });
  });

  it("仅布局变化（引用集合与数量一致）不写内容账本", async () => {
    await updateProject(
      "p1",
      1,
      { canvasData: { nodes: [{ position: { x: 9, y: 9 }, data: { src: key(HASH_A) } }] } },
      { baseRevision: 3, lease: joinAs() },
    );

    expect(mocks.updateProjectRowTx).toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefsTx).not.toHaveBeenCalled();
  });

  it("内容写缺 baseRevision：service 入口 fail-closed 拒绝", async () => {
    await expect(
      updateProject("p1", 1, { canvasData: { nodes: [] } }, { lease: joinAs() }),
    ).rejects.toThrow("requires baseRevision");

    expect(mocks.updateProjectRowTx).not.toHaveBeenCalled();
  });

  it("缺租约令牌：拒绝落库，错误携带当前版本", async () => {
    mocks.getProjectRevision.mockResolvedValue(5);

    await expect(
      updateProject("p1", 1, { canvasData: { nodes: [] } }, { baseRevision: 3 }),
    ).rejects.toMatchObject({ currentRevision: 5 });

    expect(mocks.getProjectRevision).toHaveBeenCalledWith("p1", 1);
    expect(mocks.updateProjectRowTx).not.toHaveBeenCalled();
  });

  it("被接管的旧令牌：拒绝落库，错误携带当前版本", async () => {
    const staleToken = joinAs("A");
    joinAs("B");
    mocks.getProjectRevision.mockResolvedValue(7);

    await expect(
      updateProject("p1", 1, { canvasData: { nodes: [] } }, { baseRevision: 3, lease: staleToken }),
    ).rejects.toBeInstanceOf(CanvasLeaseLostError);

    expect(mocks.updateProjectRowTx).not.toHaveBeenCalled();
  });

  it("baseRevision 与行版本不一致：抛 CanvasRevisionConflictError 并携带当前版本", async () => {
    await expect(
      updateProject("p1", 1, { canvasData: { nodes: [] } }, { baseRevision: 2, lease: joinAs() }),
    ).rejects.toMatchObject({ currentRevision: 3 });

    expect(mocks.updateProjectRowTx).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefsTx).not.toHaveBeenCalled();
  });

  it("项目不存在：返回 null，不写账本", async () => {
    mocks.getProjectRowForWriteTx.mockResolvedValue(null);

    await expect(
      updateProject("p1", 1, { canvasData: { nodes: [] } }, { baseRevision: 3, lease: joinAs() }),
    ).resolves.toBeNull();
    expect(mocks.replaceSourceFileRefsTx).not.toHaveBeenCalled();
  });

  it("行在事务内被并发删除（update 返回 null）：返回 null 并跳过账本", async () => {
    mocks.updateProjectRowTx.mockResolvedValue(null);

    await expect(
      updateProject(
        "p1",
        1,
        { canvasData: { nodes: [{ data: { src: key(HASH_B) } }] }, coverKey: key(HASH_B) },
        { baseRevision: 3, lease: joinAs() },
      ),
    ).resolves.toBeNull();

    expect(mocks.replaceSourceFileRefsTx).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefTx).not.toHaveBeenCalled();
  });

  it("内容与封面同时提交：两个来源在同一事务内各自登记", async () => {
    const canvasData = { nodes: [{ data: { src: key(HASH_B) } }] };

    await updateProject(
      "p1",
      1,
      { canvasData, coverKey: key(HASH_A) },
      { baseRevision: 3, lease: joinAs() },
    );

    expect(mocks.replaceSourceFileRefsTx).toHaveBeenCalledWith(
      TX,
      { userId: 1, sourceType: "canvas", sourceId: "p1" },
      expect.any(Map),
    );
    expect(mocks.replaceSourceFileRefTx).toHaveBeenCalledWith(
      TX,
      { userId: 1, sourceType: "canvas_cover", sourceId: "p1" },
      key(HASH_A),
    );
  });
});

describe("增量写（租约 + 版本 + 纯函数合并）", () => {
  const baseRow = {
    id: "p1",
    revision: 3,
    canvasData: {
      nodes: [
        { id: "n1", data: { src: key(HASH_A) } },
        { id: "keep", data: {} },
        { id: "old", data: {} },
      ],
      edges: [{ id: "e1", source: "n1", target: "old" }],
    },
    coverKey: null,
  };

  beforeEach(() => {
    mocks.getProjectRowForWriteTx.mockResolvedValue(structuredClone(baseRow));
  });

  it("按 ID 合并节点/边并重算引用账本，不写 name/封面", async () => {
    await updateProjectDelta("p1", 1, {
      nodes: { upsert: [{ id: "n1", data: { src: key(HASH_B) } }], delete: ["old"] },
      edges: { upsert: [], delete: ["e1"] },
    }, { baseRevision: 3, lease: joinAs() });

    const patch = mocks.updateProjectRowTx.mock.calls[0]![2] as { canvasData: Record<string, unknown>; name?: string; coverKey?: unknown };
    expect(patch.name).toBeUndefined();
    expect(patch.coverKey).toBeUndefined();
    expect(patch.canvasData).toEqual({
      nodes: [{ id: "n1", data: { src: key(HASH_B) } }, { id: "keep", data: {} }],
      edges: [],
    });
    const [, , counts] = mocks.replaceSourceFileRefsTx.mock.calls[0] as unknown as [unknown, unknown, Map<string, number>];
    expect(Object.fromEntries(counts)).toEqual({ [HASH_B]: 1 });
    expect(mocks.replaceSourceFileRefTx).not.toHaveBeenCalled();
  });

  it("缺 baseRevision：service 入口 fail-closed 拒绝，不读行不合并", async () => {
    await expect(updateProjectDelta("p1", 1, {
      nodes: { upsert: [], delete: [] },
      edges: { upsert: [], delete: [] },
    }, { lease: joinAs() })).rejects.toThrow("requires baseRevision");

    expect(mocks.getProjectRowForWriteTx).not.toHaveBeenCalled();
    expect(mocks.updateProjectRowTx).not.toHaveBeenCalled();
  });

  it("revision 不一致：抛冲突且不合并", async () => {
    await expect(updateProjectDelta("p1", 1, {
      nodes: { upsert: [], delete: [] },
      edges: { upsert: [], delete: [] },
    }, { baseRevision: 2, lease: joinAs() })).rejects.toBeInstanceOf(CanvasRevisionConflictError);

    expect(mocks.updateProjectRowTx).not.toHaveBeenCalled();
  });

  it("租约失效：拒绝且不合并", async () => {
    const staleToken = joinAs("A");
    joinAs("B");
    mocks.getProjectRevision.mockResolvedValue(9);

    await expect(updateProjectDelta("p1", 1, {
      nodes: { upsert: [], delete: [] },
      edges: { upsert: [], delete: [] },
    }, { baseRevision: 3, lease: staleToken })).rejects.toMatchObject({ currentRevision: 9 });

    expect(mocks.updateProjectRowTx).not.toHaveBeenCalled();
  });

  it("项目不存在：返回 null", async () => {
    mocks.getProjectRowForWriteTx.mockResolvedValue(null);

    await expect(updateProjectDelta("p1", 1, {
      nodes: { upsert: [], delete: [] },
      edges: { upsert: [], delete: [] },
    }, { baseRevision: 3, lease: joinAs() })).resolves.toBeNull();
  });
});
