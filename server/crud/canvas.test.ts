import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  replaceSourceFileRefs: vi.fn(),
  removeSourceFileRefs: vi.fn(),
}));

vi.mock("@server/core/database/client", () => ({
  prisma: {
    $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({
      canvasProject: { findFirst: mocks.findFirst, update: mocks.update },
    })),
  },
}));
vi.mock("@server/services/storage/file-ref-ledger", () => ({
  replaceSourceFileRefs: mocks.replaceSourceFileRefs,
  removeSourceFileRefs: mocks.removeSourceFileRefs,
}));

import { updateProject } from "./canvas";
import { stringifyJson } from "./json-column";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const url = (hash: string) => `/api/files/1/${hash.slice(0, 2)}/${hash}.png`;
const canvas = (srcs: string[]) => stringifyJson({ nodes: srcs.map((src) => ({ data: { src } })) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue({ id: "p1", revision: 3, canvasData: canvas([url(HASH_A)]) });
  mocks.update.mockResolvedValue({ id: "p1", revision: 4, canvasData: canvas([url(HASH_A)]) });
});

describe("updateProject 引用账本重算（服务端权威判定）", () => {
  it("引用集合变化时重算账本", async () => {
    const newCanvas = { nodes: [{ data: { src: url(HASH_B) } }] };
    await updateProject("p1", 1, { canvasData: newCanvas }, { baseRevision: 3 });

    expect(mocks.replaceSourceFileRefs).toHaveBeenCalledTimes(1);
    const [, , counts] = mocks.replaceSourceFileRefs.mock.calls[0] as unknown as [unknown, unknown, Map<string, number>];
    expect(Object.fromEntries(counts)).toEqual({ [HASH_B]: 1 });
  });

  it("引用数量变化（复制节点）时重算账本", async () => {
    const newCanvas = { nodes: [{ data: { src: url(HASH_A) } }, { data: { src: url(HASH_A) } }] };
    await updateProject("p1", 1, { canvasData: newCanvas }, { baseRevision: 3 });

    expect(mocks.replaceSourceFileRefs).toHaveBeenCalledTimes(1);
    const [, , counts] = mocks.replaceSourceFileRefs.mock.calls[0] as unknown as [unknown, unknown, Map<string, number>];
    expect(Object.fromEntries(counts)).toEqual({ [HASH_A]: 2 });
  });

  it("仅布局变化（引用集合与数量一致）不写账本", async () => {
    const newCanvas = {
      nodes: [{ position: { x: 999, y: 999 }, data: { src: url(HASH_A) } }],
    };
    await updateProject("p1", 1, { canvasData: newCanvas }, { baseRevision: 3 });

    expect(mocks.replaceSourceFileRefs).not.toHaveBeenCalled();
  });

  it("纯改名（无 canvasData）不写账本也不递增 revision", async () => {
    await updateProject("p1", 1, { name: "renamed" });

    expect(mocks.replaceSourceFileRefs).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { name: "renamed" },
    });
  });
});
