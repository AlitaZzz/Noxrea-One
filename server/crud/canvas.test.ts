import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  directFindFirst: vi.fn(),
  replaceSourceFileRefs: vi.fn(),
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
  removeSourceFileRefs: mocks.removeSourceFileRefs,
}));

import { updateProject, deleteProject, projectExists, CanvasCoverUrlError, CanvasLeaseLostError } from "./canvas";
import { joinCanvasRoom, resetCanvasPresence } from "@server/services/canvas/editor-lease";
import { stringifyJson } from "./json-column";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const url = (hash: string) => `/api/files/1/${hash.slice(0, 2)}/${hash}.png`;
const canvas = (srcs: string[]) => stringifyJson({ nodes: srcs.map((src) => ({ data: { src } })) });

/** 在项目 p1 的房间内取得真实租约令牌（编辑权语义由 editor-lease 提供） */
function joinAs(sid = "A") {
  return joinCanvasRoom("p1", sid, () => {}).leaseToken;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCanvasPresence();
  mocks.findFirst.mockResolvedValue({ id: "p1", revision: 3, canvasData: canvas([url(HASH_A)]) });
  mocks.directFindFirst.mockResolvedValue({ id: "p1", revision: 3 });
  mocks.update.mockResolvedValue({ id: "p1", revision: 4, canvasData: canvas([url(HASH_A)]) });
});

describe("updateProject 引用账本重算（服务端权威判定）", () => {
  it("引用集合变化时重算账本", async () => {
    const newCanvas = { nodes: [{ data: { src: url(HASH_B) } }] };
    await updateProject("p1", 1, { canvasData: newCanvas }, { baseRevision: 3, lease: joinAs() });

    expect(mocks.replaceSourceFileRefs).toHaveBeenCalledTimes(1);
    const [, , counts] = mocks.replaceSourceFileRefs.mock.calls[0] as unknown as [unknown, unknown, Map<string, number>];
    expect(Object.fromEntries(counts)).toEqual({ [HASH_B]: 1 });
  });

  it("引用数量变化（复制节点）时重算账本", async () => {
    const newCanvas = { nodes: [{ data: { src: url(HASH_A) } }, { data: { src: url(HASH_A) } }] };
    await updateProject("p1", 1, { canvasData: newCanvas }, { baseRevision: 3, lease: joinAs() });

    expect(mocks.replaceSourceFileRefs).toHaveBeenCalledTimes(1);
    const [, , counts] = mocks.replaceSourceFileRefs.mock.calls[0] as unknown as [unknown, unknown, Map<string, number>];
    expect(Object.fromEntries(counts)).toEqual({ [HASH_A]: 2 });
  });

  it("仅布局变化（引用集合与数量一致）不写账本", async () => {
    const newCanvas = {
      nodes: [{ position: { x: 999, y: 999 }, data: { src: url(HASH_A) } }],
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
    await updateProject("p1", 1, { coverUrl: url(HASH_B) });

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { coverUrl: url(HASH_B) },
    });
    expect(mocks.replaceSourceFileRefs).toHaveBeenCalledTimes(1);
    const [, source, counts] = mocks.replaceSourceFileRefs.mock.calls[0] as unknown as [
      unknown,
      { sourceType: string; sourceId: string },
      Map<string, number>,
    ];
    expect(source.sourceType).toBe("canvas_cover");
    expect(source.sourceId).toBe("p1");
    expect(Object.fromEntries(counts)).toEqual({ [HASH_B]: 1 });
  });

  it("清除封面（null）：canvas_cover 来源整替为空集", async () => {
    await updateProject("p1", 1, { coverUrl: null });

    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { coverUrl: null },
    });
    const [, , counts] = mocks.replaceSourceFileRefs.mock.calls[0] as unknown as [unknown, unknown, Map<string, number>];
    expect(counts.size).toBe(0);
  });

  it("封面不是本站 files URL：拒绝且不落库不写账本", async () => {
    await expect(updateProject("p1", 1, { coverUrl: "https://evil.example/x.png" }))
      .rejects.toBeInstanceOf(CanvasCoverUrlError);

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefs).not.toHaveBeenCalled();
  });

  it("封面与画布保存同时提交：两个来源各自登记互不覆盖", async () => {
    const newCanvas = { nodes: [{ data: { src: url(HASH_B) } }] };
    await updateProject("p1", 1, { canvasData: newCanvas, coverUrl: url(HASH_A) }, { baseRevision: 3, lease: joinAs() });

    const calls = mocks.replaceSourceFileRefs.mock.calls as unknown as Array<
      [unknown, { sourceType: string }, Map<string, number>]
    >;
    expect(calls).toHaveLength(2);
    const bySource = new Map(calls.map(([, source, counts]) => [source.sourceType, Object.fromEntries(counts)]));
    expect(bySource.get("canvas")).toEqual({ [HASH_B]: 1 });
    expect(bySource.get("canvas_cover")).toEqual({ [HASH_A]: 1 });
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
