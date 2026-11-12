/**
 * 批量创建单行插入原语的返回值语义。
 * 真实索引裁决见 asset-batch-create-race-db.test.ts；这里锁定原语对空结果
 * 的解释：有来源键 = 唯一索引判定冲突，无来源键 = 索引契约被破坏。
 */
import type { Prisma } from "@server/core/database/generated/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@server/core/database/client", () => ({ prisma: {} }));

import { insertAssetItemRowTx, type NewAssetItemRow } from "@server/crud/asset";

const baseRow: NewAssetItemRow = {
  userId: 1,
  folderId: 2,
  scope: "personal",
  fileKey: null,
  sourceType: "upload",
  name: "asset",
  type: "image",
  mediaType: "",
  description: "",
  tags: [],
  prompt: "",
};

function makeTx(rows: unknown[]) {
  const $queryRaw = vi.fn(async () => rows);
  return { tx: { $queryRaw } as unknown as Prisma.TransactionClient, $queryRaw };
}

describe("insertAssetItemRowTx", () => {
  it("有来源键的空结果按唯一索引冲突返回来源键", async () => {
    const { tx } = makeTx([]);
    const fileKey = "1/aa/asset.png";

    await expect(insertAssetItemRowTx(tx, { ...baseRow, fileKey })).resolves.toEqual({
      status: "conflict",
      fileKey,
    });
  });

  it("无来源键的空结果说明唯一索引契约被破坏，直接抛错", async () => {
    const { tx } = makeTx([]);

    await expect(insertAssetItemRowTx(tx, baseRow)).rejects.toThrow(
      "source unique index skipped a row without a file key",
    );
  });

  it("返回行按插入成功返回", async () => {
    const record = { id: 9, fileKey: "1/aa/asset.png" };
    const { tx } = makeTx([record]);

    await expect(
      insertAssetItemRowTx(tx, { ...baseRow, fileKey: record.fileKey }),
    ).resolves.toEqual({ status: "inserted", item: record });
  });
});
