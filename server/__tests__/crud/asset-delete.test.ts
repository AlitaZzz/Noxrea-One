/**
 * 资产删除回归测试：实际删除集是账本清理与目录计数的唯一依据。
 * 并发删除/移出场景下，调用前的快照只能用于定位，不得直接用于递减；
 * 因此用严格子集 RETURNING 锁定「只按实际删掉的行结算」的语义。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  assetItemFindFirst: vi.fn(),
  assetItemFindMany: vi.fn(),
  folderFindFirst: vi.fn(),
  folderFindMany: vi.fn(),
  folderUpdate: vi.fn(),
  folderDeleteMany: vi.fn(),
  fileObjectFindMany: vi.fn(),
  removeSourceFileRefsBatchTx: vi.fn(),
}));

vi.mock("@server/core/database/client", () => ({
  prisma: {
    assetItem: { findFirst: mocks.assetItemFindFirst, findMany: mocks.assetItemFindMany },
    assetFolder: {
      findFirst: mocks.folderFindFirst,
      findMany: mocks.folderFindMany,
      update: mocks.folderUpdate,
      deleteMany: mocks.folderDeleteMany,
    },
    fileObject: { findMany: mocks.fileObjectFindMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@server/crud/file-ref-ledger", () => ({
  replaceSourceFileRefTx: vi.fn(),
  removeSourceFileRefsBatchTx: mocks.removeSourceFileRefsBatchTx,
}));

import {
  AssetOperationError,
  deleteAsset,
  deleteAssetItemsTx,
  deleteFolder,
} from "@server/crud/asset";

const TX = {
  $queryRaw: mocks.queryRaw,
  assetItem: { findFirst: mocks.assetItemFindFirst, findMany: mocks.assetItemFindMany },
  assetFolder: {
    findFirst: mocks.folderFindFirst,
    findMany: mocks.folderFindMany,
    update: mocks.folderUpdate,
    deleteMany: mocks.folderDeleteMany,
  },
  fileObject: { findMany: mocks.fileObjectFindMany },
};

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    userId: 7,
    folderId: 10,
    scope: "personal",
    fileKey: null,
    sourceType: "upload",
    name: "n",
    type: "image",
    mediaType: "image",
    description: "",
    tags: "[]",
    prompt: "",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(TX));
  mocks.fileObjectFindMany.mockResolvedValue([]);
  mocks.folderFindMany.mockResolvedValue([]);
  mocks.folderUpdate.mockResolvedValue({});
  mocks.folderDeleteMany.mockResolvedValue({ count: 0 });
});

describe("deleteAssetItemsTx（实际删除集是唯一结算依据）", () => {
  it("并发只删到部分行时，只按 RETURNING 返回的行清账本并递减目录计数", async () => {
    mocks.queryRaw.mockResolvedValue([
      { id: 1, user_id: 7, folder_id: 10, file_key: "1/aa/aa.png" },
    ]);

    const deleted = await deleteAssetItemsTx(TX as never, [
      { id: 1, userId: 7 },
      { id: 2, userId: 7 },
    ]);

    expect(deleted).toEqual([{ id: 1, userId: 7, folderId: 10, fileKey: "1/aa/aa.png" }]);
    expect(mocks.removeSourceFileRefsBatchTx).toHaveBeenCalledWith(TX, {
      userId: 7,
      sourceType: "asset_item",
      sourceIds: ["1"],
    });
    expect(mocks.folderUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.folderUpdate).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { directCount: { decrement: 1 } },
    });
  });

  it("同一目录的多行按实际条数聚合成一次递减", async () => {
    mocks.queryRaw.mockResolvedValue([
      { id: 1, user_id: 7, folder_id: 10, file_key: null },
      { id: 2, user_id: 7, folder_id: 10, file_key: null },
      { id: 3, user_id: 7, folder_id: 11, file_key: null },
    ]);

    await deleteAssetItemsTx(TX as never, [
      { id: 1, userId: 7 },
      { id: 2, userId: 7 },
      { id: 3, userId: 7 },
    ]);

    expect(mocks.folderUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.folderUpdate).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { directCount: { decrement: 2 } },
    });
    expect(mocks.folderUpdate).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { directCount: { decrement: 1 } },
    });
  });

  it("空输入不发起任何 SQL 或账本调用", async () => {
    await expect(deleteAssetItemsTx(TX as never, [])).resolves.toEqual([]);

    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.removeSourceFileRefsBatchTx).not.toHaveBeenCalled();
    expect(mocks.folderUpdate).not.toHaveBeenCalled();
  });

  it("删除谓词按 (id, user_id) 成对匹配，混合所有者不会交叉命中", async () => {
    mocks.queryRaw.mockResolvedValue([]);

    await deleteAssetItemsTx(TX as never, [
      { id: 1, userId: 7 },
      { id: 2, userId: 8 },
    ]);

    const sql = mocks.queryRaw.mock.calls[0][0] as { strings: readonly string[]; values: unknown[] };
    expect(sql.strings.join("?")).toContain("(id, user_id) IN");
    expect(sql.strings.join("?")).not.toContain("user_id IN");
    expect(sql.values).toEqual([1, 7, 2, 8]);
  });
});

describe("deleteAsset（并发删除后的实际结果）", () => {
  it("预读行存在但实际删除 0 行时按 asset_not_found 失败，不触碰账本与目录计数", async () => {
    mocks.assetItemFindFirst.mockResolvedValue(assetRow());
    mocks.queryRaw.mockResolvedValue([]);

    await expect(deleteAsset(7, 1)).rejects.toBeInstanceOf(AssetOperationError);
    expect(mocks.removeSourceFileRefsBatchTx).not.toHaveBeenCalled();
    expect(mocks.folderUpdate).not.toHaveBeenCalled();
  });

  it("成功删除时返回预读快照，并把实际删除行交给账本", async () => {
    mocks.assetItemFindFirst.mockResolvedValue(assetRow());
    mocks.queryRaw.mockResolvedValue([
      { id: 1, user_id: 7, folder_id: 10, file_key: null },
    ]);
    mocks.folderFindMany.mockResolvedValue([{ id: 10, directCount: 0 }]);

    const result = await deleteAsset(7, 1);

    expect(result.item).toMatchObject({ id: 1, tags: [] });
    expect(result.counters).toEqual({ folders: { "10": 0 }, total: 0 });
    expect(mocks.removeSourceFileRefsBatchTx).toHaveBeenCalledWith(TX, {
      userId: 7,
      sourceType: "asset_item",
      sourceIds: ["1"],
    });
  });
});

describe("deleteFolder（子树内实际删除行）", () => {
  it("按 RETURNING 实际行清账本、聚合计数并删除子树目录", async () => {
    mocks.folderFindFirst.mockResolvedValue({
      id: 2,
      userId: 7,
      scope: "personal",
      kind: "normal",
    });
    mocks.folderFindMany.mockImplementation(async (args: { select: Record<string, unknown> }) => {
      if (args.select.parentId) {
        return [
          { id: 1, parentId: null },
          { id: 2, parentId: 1 },
          { id: 3, parentId: 2 },
          { id: 4, parentId: 1 },
        ];
      }
      return [
        { id: 1, directCount: 0 },
        { id: 4, directCount: 0 },
      ];
    });
    mocks.queryRaw.mockResolvedValue([
      { id: 11, file_key: "1/aa/aa.png" },
      { id: 12, file_key: null },
    ]);
    mocks.folderDeleteMany.mockResolvedValue({ count: 2 });

    const result = await deleteFolder(7, 2);

    expect(result).toEqual({
      removedCount: 2,
      fileKeys: ["1/aa/aa.png"],
      counters: { folders: { "1": 0, "4": 0 }, total: 0 },
    });
    expect(mocks.removeSourceFileRefsBatchTx).toHaveBeenCalledWith(TX, {
      userId: 7,
      sourceType: "asset_item",
      sourceIds: ["11", "12"],
    });
    const deleteWhere = mocks.folderDeleteMany.mock.calls[0][0].where;
    expect(deleteWhere.userId).toBe(7);
    expect(deleteWhere.id.in).toHaveLength(2);
    expect(deleteWhere.id.in).toEqual(expect.arrayContaining([2, 3]));
    expect(deleteWhere.id.in).not.toContain(1);
    expect(deleteWhere.id.in).not.toContain(4);
  });
});
