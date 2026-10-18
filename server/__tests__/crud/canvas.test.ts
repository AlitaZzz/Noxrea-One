import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  directFindFirst: vi.fn(),
  replaceSourceFileRefs: vi.fn(),
  replaceSourceFileRef: vi.fn(),
  removeSourceFileRefs: vi.fn(),
}));

vi.mock("@server/core/database/client", () => ({
  prisma: {
    // 事务外的直读（租约失效时读当前版本、存在性探测）
    canvasProject: { findFirst: mocks.directFindFirst },
    $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({
      canvasProject: { findFirst: mocks.findFirst, update: mocks.update, deleteMany: mocks.deleteMany },
    })),
  },
}));
vi.mock("@server/services/storage/file-ref-ledger", () => ({
  replaceSourceFileRefs: mocks.replaceSourceFileRefs,
  replaceSourceFileRef: mocks.replaceSourceFileRef,
  removeSourceFileRefs: mocks.removeSourceFileRefs,
}));

import { updateProject, updateProjectDelta, deleteProject, projectExists, CanvasCoverKeyError, CanvasLeaseLostError } from "@server/crud/canvas";
import { joinCanvasRoom, resetCanvasPresence } from "@server/services/canvas/editor-lease";
import { stringifyJson } from "@server/crud/json-column";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
// 引用值域 = 存储 key（节点 src 与封面同值域，specs/storage-reference-key-unification.md）
const key = (hash: string) => `1/${hash.slice(0, 2)}/${hash}.png`;
const canvas = (srcs: string[]) => stringifyJson({ nodes: srcs.map((src) => ({ data: { src } })) });

/** 在项目 p1 的房间内取得真实租约令牌（编辑权语义由 editor-lease 提供） */
function joinAs(sid = "A") {
  return joinCanvasRoom("p1", sid, () => {}).leaseToken;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCanvasPresence();
  mocks.findFirst.mockResolvedValue({ id: "p1", revision: 3, canvasData: canvas([key(HASH_A)]) });
  mocks.directFindFirst.mockResolvedValue({ id: "p1", revision: 3 });
  mocks.update.mockResolvedValue({ id: "p1", revision: 4, canvasData: canvas([key(HASH_A)]) });
});

describe("updateProject 引用账本重算（服务端权威判定）", () => {
  it("引用集合变化时重算账本", async () => {
    const newCanvas = { nodes: [{ data: { src: key(HASH_B) } }] };
    await updateProject("p1", 1, { canvasData: newCanvas }, { baseRevision: 3, lease: joinAs() });

    expect(mocks.replaceSourceFileRefs).toHaveBeenCalledTimes(1);
    const [, , counts] = mocks.replaceSourceFileRefs.mock.calls[0] as unknown as [unknown, unknown, Map<string, number>];
    expect(Object.fromEntries(counts)).toEqual({ [HASH_B]: 1 });
  });

  it("引用数量变化（复制节点）时重算账本", async () => {
    const newCanvas = { nodes: [{ data: { src: key(HASH_A) } }, { data: { src: key(HASH_A) } }] };
    await updateProject("p1", 1, { canvasData: newCanvas }, { baseRevision: 3, lease: joinAs() });

    expect(mocks.replaceSourceFileRefs).toHaveBeenCalledTimes(1);
    const [, , counts] = mocks.replaceSourceFileRefs.mock.calls[0] as unknown as [unknown, unknown, Map<string, number>];
    expect(Object.fromEntries(counts)).toEqual({ [HASH_A]: 2 });
  });

  it("仅布局变化（引用集合与数量一致）不写账本", async () => {
    const newCanvas = {
      nodes: [{ position: { x: 999, y: 999 }, data: { src: key(HASH_A) } }],
    };
    await updateProject("p1", 1, { canvasData: newCanvas }, { baseRevision: 3, lease: joinAs() });

    expect(mocks.replaceSourceFileRefs).not.toHaveBeenCalled();
  });

  it("纯改名（无 canvasData）不写账本也不递增 revision，且免租约", async () => {
    await updateProject("p1", 1, { name: "renamed" });

    expect(mocks.replaceSourceFileRefs).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { name: "renamed" },
    });
  });

  it("设置封面：canvas_cover 来源登记 hash→1，与画布内容来源正交", async () => {
    await updateProject("p1", 1, { coverKey: key(HASH_B) });

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { coverKey: key(HASH_B) },
    });
    expect(mocks.replaceSourceFileRef).toHaveBeenCalledTimes(1);
    expect(mocks.replaceSourceFileRefs).not.toHaveBeenCalled();
    const [, source, value] = mocks.replaceSourceFileRef.mock.calls[0] as unknown as [
      unknown,
      { sourceType: string; sourceId: string },
      string,
    ];
    expect(source.sourceType).toBe("canvas_cover");
    expect(source.sourceId).toBe("p1");
    expect(value).toBe(key(HASH_B));
  });

  it("清除封面（null）：canvas_cover 来源整替为空集", async () => {
    await updateProject("p1", 1, { coverKey: null });

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { coverKey: null },
    });
    expect(mocks.replaceSourceFileRef).toHaveBeenCalledTimes(1);
    expect(mocks.replaceSourceFileRef.mock.calls[0][2]).toBeNull();
  });

  it("封面不是合法存储 key（外部 URL）：拒绝且不落库不写账本", async () => {
    await expect(updateProject("p1", 1, { coverKey: "https://evil.example/x.png" }))
      .rejects.toBeInstanceOf(CanvasCoverKeyError);

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefs).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRef).not.toHaveBeenCalled();
  });

  it("封面与画布保存同时提交：两个来源各自登记互不覆盖", async () => {
    const newCanvas = { nodes: [{ data: { src: key(HASH_B) } }] };
    await updateProject("p1", 1, { canvasData: newCanvas, coverKey: key(HASH_A) }, { baseRevision: 3, lease: joinAs() });

    expect(mocks.replaceSourceFileRefs).toHaveBeenCalledTimes(1);
    const [, contentSource, contentCounts] = mocks.replaceSourceFileRefs.mock.calls[0] as unknown as [
      unknown,
      { sourceType: string },
      Map<string, number>,
    ];
    expect(contentSource.sourceType).toBe("canvas");
    expect(Object.fromEntries(contentCounts)).toEqual({ [HASH_B]: 1 });
    expect(mocks.replaceSourceFileRef).toHaveBeenCalledTimes(1);
    const [, coverSource, coverValue] = mocks.replaceSourceFileRef.mock.calls[0] as unknown as [
      unknown,
      { sourceType: string },
      string,
    ];
    expect(coverSource.sourceType).toBe("canvas_cover");
    expect(coverValue).toBe(key(HASH_A));
  });

  it("删除项目：canvas 与 canvas_cover 两个来源的账本引用一并清理", async () => {
    mocks.removeSourceFileRefs.mockClear();
    await deleteProject("p1", 1);

    const sources = mocks.removeSourceFileRefs.mock.calls.map(
      (call: unknown[]) => (call[1] as { sourceType: string }).sourceType,
    );
    expect(sources).toEqual(["canvas", "canvas_cover"]);
  });
});

describe("updateProjectDelta 原子合并", () => {
  it("按 ID 合并节点/边并重算摘要与引用账本", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "p1", revision: 3,
      canvasData: stringifyJson({
        nodes: [
          { id: "n1", data: { src: key(HASH_A) } },
          { id: "keep", data: {} },
          { id: "old", data: {} },
        ],
        edges: [{ id: "e1", source: "n1", target: "old" }],
      }),
    });
    mocks.update.mockResolvedValue({
      id: "p1", revision: 4,
      canvasData: stringifyJson({ nodes: [], edges: [] }),
    });
    await updateProjectDelta("p1", 1, {
      nodes: { upsert: [{ id: "n1", data: { src: key(HASH_B) } }], delete: ["old"] },
      edges: { upsert: [], delete: ["e1"] },
    }, { baseRevision: 3, lease: joinAs() });

    const update = mocks.update.mock.calls[0]![0] as { data: { canvasData: string; revision: unknown } };
    expect(JSON.parse(update.data.canvasData)).toEqual({
      nodes: [{ id: "n1", data: { src: key(HASH_B) } }, { id: "keep", data: {} }],
      edges: [],
    });
    expect(update.data.revision).toEqual({ increment: 1 });
    expect(mocks.replaceSourceFileRefs).toHaveBeenCalledTimes(1);
    const [, , counts] = mocks.replaceSourceFileRefs.mock.calls[0] as unknown as [unknown, unknown, Map<string, number>];
    expect(Object.fromEntries(counts)).toEqual({ [HASH_B]: 1 });
  });

  it("revision 不一致时不合并", async () => {
    await expect(updateProjectDelta("p1", 1, {
      nodes: { upsert: [], delete: [] }, edges: { upsert: [] , delete: [] },
    }, { baseRevision: 2, lease: joinAs() })).rejects.toMatchObject({ currentRevision: 3 });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("updateProject 租约校验（fencing token，lost update 结构性防线）", () => {
  it("带 canvasData 但缺租约令牌：拒绝落库", async () => {
    await expect(updateProject("p1", 1, { canvasData: { nodes: [] } }, { baseRevision: 3 }))
      .rejects.toBeInstanceOf(CanvasLeaseLostError);

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefs).not.toHaveBeenCalled();
  });

  it("被接管的旧令牌：拒绝落库，错误携带当前版本供 409 回传", async () => {
    const staleToken = joinAs("A");
    joinAs("B"); // B 抢占，A 的令牌随即失效

    mocks.directFindFirst.mockResolvedValue({ id: "p1", revision: 7 });
    await expect(
      updateProject("p1", 1, { canvasData: { nodes: [] } }, { baseRevision: 3, lease: staleToken }),
    ).rejects.toMatchObject({ currentRevision: 7 });

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefs).not.toHaveBeenCalled();
  });

  it("当前令牌 + baseRevision 一致：正常落库（回归路径）", async () => {
    await updateProject("p1", 1, { canvasData: { nodes: [] } }, { baseRevision: 3, lease: joinAs() });
    expect(mocks.update).toHaveBeenCalled();
  });
});

describe("projectExists 存在性探测", () => {
  it("存在与不存在分别返回布尔，且只 select id", async () => {
    mocks.directFindFirst.mockResolvedValue({ id: "p1" });
    await expect(projectExists("p1", 1)).resolves.toBe(true);

    mocks.directFindFirst.mockResolvedValue(null);
    await expect(projectExists("p1", 1)).resolves.toBe(false);

    expect(mocks.directFindFirst).toHaveBeenCalledWith({ where: { id: "p1", userId: 1 }, select: { id: true } });
  });
});
