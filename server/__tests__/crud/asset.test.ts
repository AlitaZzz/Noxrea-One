/**
 * 资产 CRUD 回归测试。
 * 纯函数直测：游标编解码（keyset 分页契约）、文件夹子树展开（含环容错）。
 * getAssets 用 mock prisma 锁编排：scope 过滤、type 逗号拆分、游标 where 构造、
 * take+1 判页与 nextCursor 生成、limit 钳位、宽高 join 的 hash 提取。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assetItem: { findMany: vi.fn(), count: vi.fn() },
  assetFolder: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  fileObject: { findMany: vi.fn() },
}));

vi.mock("@server/core/database/client", () => ({
  prisma: {
    assetItem: mocks.assetItem,
    assetFolder: mocks.assetFolder,
    fileObject: mocks.fileObject,
    $transaction: vi.fn(),
  },
}));

import {
  collectSubtreeIds,
  encodeAssetCursor,
  getAssets,
  parseAssetCursor,
} from "@server/crud/asset";

const HASH_A = "a".repeat(64);
const sourceUrl = (hash: string) => `/api/files/1/${hash.slice(0, 2)}/${hash}.png`;

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, userId: 1, folderId: 2, scope: "personal",
    sourceUrl: sourceUrl(HASH_A), sourceType: "upload",
    name: "n", type: "image", mediaType: "image",
    description: "", tags: "[]", prompt: "",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("游标编解码（keyset 分页契约）", () => {
  it("编码 → 解析往返一致", () => {
    const cursor = encodeAssetCursor({ createdAt: new Date(1727000000000), id: 42 });
    expect(cursor).toBe("1727000000000_42");
    expect(parseAssetCursor(cursor)).toEqual({
      createdAt: new Date(1727000000000),
      id: 42,
    });
  });

  it("非法游标返回 null（游标损坏按首页处理，不炸列表）", () => {
    expect(parseAssetCursor("garbage")).toBeNull();
    expect(parseAssetCursor("12_34_56")).toBeNull();
    expect(parseAssetCursor("")).toBeNull();
  });
});

describe("collectSubtreeIds（文件夹子树展开）", () => {
  const folders = [
    { id: 1, parentId: null },
    { id: 2, parentId: 1 },
    { id: 3, parentId: 2 },
    { id: 4, parentId: 1 },
    { id: 5, parentId: null },
  ];

  it("展开完整后代含自身", () => {
    const ids = collectSubtreeIds(1, folders);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
    expect(ids).toContain(4);
    expect(ids).not.toContain(5);
  });

  it("叶子目录只含自身", () => {
    expect(collectSubtreeIds(3, folders)).toEqual([3]);
  });

  it("父链成环时终止不死循环", () => {
    const cyclic = [
      { id: 1, parentId: 2 as number | null },
      { id: 2, parentId: 1 as number | null },
    ];
    const ids = collectSubtreeIds(1, cyclic);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
  });
});

describe("getAssets（mock prisma 编排）", () => {
  it("默认 scope 与分页：take=limit+1、无更多页时 nextCursor 为 null", async () => {
    mocks.assetItem.findMany.mockResolvedValue([assetRow()]);
    mocks.assetItem.count.mockResolvedValue(1);
    mocks.fileObject.findMany.mockResolvedValue([
      { hash: HASH_A, size: 10n, width: 100, height: 50, duration: null },
    ]);

    const result = await getAssets({ userId: 1 });

    const args = mocks.assetItem.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 1, scope: "personal" });
    expect(args.take).toBe(21);
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(result.total).toBe(1);
    expect(result.nextCursor).toBeNull();

    // 宽高 join：sourceUrl 提取 hash 查 file_objects
    expect(result.items[0].width).toBe(100);
    expect(result.items[0].height).toBe(50);
    expect(result.items[0].size).toBe(10);
  });

  it("type 逗号串拆分为 in 过滤", async () => {
    mocks.assetItem.findMany.mockResolvedValue([]);
    mocks.assetItem.count.mockResolvedValue(0);

    await getAssets({ userId: 1, type: "image, video , " });

    const where = mocks.assetItem.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([{ type: { in: ["image", "video"] } }]);
  });

  it("游标构造严格更旧条件；满页时以末行生成 nextCursor", async () => {
    const older = assetRow({
      id: 7,
      createdAt: new Date(1727000000000),
      sourceUrl: null,
    });
    // take+1 条：满页 2 条 + 1 条说明还有更多
    mocks.assetItem.findMany.mockResolvedValue([
      assetRow({ id: 9, createdAt: new Date(1728000000000), sourceUrl: null }),
      assetRow({ id: 8, createdAt: new Date(1728000000000), sourceUrl: null }),
      older,
    ]);
    mocks.assetItem.count.mockResolvedValue(3);

    const result = await getAssets({ userId: 1, limit: 2, cursor: "1728000000000_10" });

    const listWhere = mocks.assetItem.findMany.mock.calls[0][0].where;
    const cursorClause = listWhere.AND.find(
      (c: { OR?: unknown[] }) => Array.isArray(c.OR),
    );
    expect(cursorClause.OR).toEqual([
      { createdAt: { lt: new Date(1728000000000) } },
      { createdAt: new Date(1728000000000), id: { lt: 10 } },
    ]);

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe("1728000000000_8");
  });

  it("limit 钳位到 200（take 201 防超大批量）", async () => {
    mocks.assetItem.findMany.mockResolvedValue([]);
    mocks.assetItem.count.mockResolvedValue(0);

    await getAssets({ userId: 1, limit: 1000 });

    expect(mocks.assetItem.findMany.mock.calls[0][0].take).toBe(201);
  });
});
