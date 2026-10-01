/**
 * adjustFileRefCount 直测（R3-6：file-ref-ledger.test 中该函数被 mock，
 * 这是账本事实来源组件本身的回归锁定）。
 * 锁定：差值语义（正增/负减/零短路）、upsert 兜底形状、
 * P2025（聚合行已被外部清理）吞掉不阻塞账本删除、其他错误原样抛出。
 */
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@server/core/database/client", () => ({ prisma: {} }));

import { adjustFileRefCount } from "@server/crud/file";

function makeTx() {
  return {
    fileObject: {
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("adjustFileRefCount", () => {
  let tx: ReturnType<typeof makeTx>;
  beforeEach(() => {
    tx = makeTx();
  });

  it("delta=0 直接返回，不触库", async () => {
    await adjustFileRefCount(tx as never, 1, "h1", 0);
    expect(tx.fileObject.upsert).not.toHaveBeenCalled();
    expect(tx.fileObject.update).not.toHaveBeenCalled();
  });

  it("delta>0 → upsert：已有行增量，无行以 delta 为初始 refCount", async () => {
    await adjustFileRefCount(tx as never, 1, "h1", 3);
    expect(tx.fileObject.upsert).toHaveBeenCalledWith({
      where: { userId_hash: { userId: 1, hash: "h1" } },
      update: { refCount: { increment: 3 } },
      create: { userId: 1, hash: "h1", refCount: 3, size: 0, mimeType: "", ext: "" },
    });
    expect(tx.fileObject.update).not.toHaveBeenCalled();
  });

  it("delta<0 → update decrement（-delta）", async () => {
    await adjustFileRefCount(tx as never, 1, "h1", -2);
    expect(tx.fileObject.update).toHaveBeenCalledWith({
      where: { userId_hash: { userId: 1, hash: "h1" } },
      data: { refCount: { decrement: 2 } },
    });
    expect(tx.fileObject.upsert).not.toHaveBeenCalled();
  });

  it("delta<0 遇 P2025（聚合行已被外部清理）→ 吞掉不抛", async () => {
    tx.fileObject.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("not found", { code: "P2025", clientVersion: "test" })
    );
    await expect(adjustFileRefCount(tx as never, 1, "h1", -1)).resolves.toBeUndefined();
  });

  it("delta<0 遇其他错误 → 原样抛出（不吞）", async () => {
    tx.fileObject.update.mockRejectedValueOnce(new Error("boom"));
    await expect(adjustFileRefCount(tx as never, 1, "h1", -1)).rejects.toThrow("boom");
  });
});
