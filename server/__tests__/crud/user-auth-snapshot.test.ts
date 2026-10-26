/**
 * 用户写路径的鉴权快照失效接线（specs/auth-request-verification.md 规则 4.2 / 4.5）。
 *
 * 锁定：`setUserPassword`（tokenVersion 递增）与「`updateUser` 写入 isActive」都在事务
 * 提交后调用 `invalidateAuthSnapshot`；画像字段（头像 / 主题 / 语言）不触发失效。
 * 失效本身的行为由 `core/auth/snapshot.test.ts` 覆盖，这里只断言接线，因此 mock 掉
 * 快照模块与数据库客户端，不依赖真实库。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  transaction: vi.fn(),
  useTx: vi.fn(),
  findUnique: vi.fn(),
  replaceSourceFileRef: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@server/core/database/client", () => ({
  prisma: {
    user: { update: mocks.update },
    // 事务内的 user.update 与 fileObject.findUnique 走 tx 替身；账本整体替换同样在事务内
    $transaction: mocks.transaction,
  },
}));
vi.mock("@server/core/auth/snapshot", () => ({ invalidateAuthSnapshot: mocks.invalidate }));
vi.mock("@server/services/storage/file-ref-ledger", () => ({
  replaceSourceFileRef: mocks.replaceSourceFileRef,
}));

import { setUserPassword, updateUser } from "@server/crud/user";

/** 用户行：失效入参取的是提交后的行，因此每行都带 id / isActive / tokenVersion */
const userRow = { id: 7, isActive: true, tokenVersion: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue(userRow);
  mocks.findUnique.mockResolvedValue({ hash: "h" });
  mocks.useTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      user: { update: mocks.update },
      fileObject: { findUnique: mocks.findUnique },
    }),
  );
  mocks.transaction.mockImplementation(mocks.useTx);
});

describe("setUserPassword", () => {
  it("提交后以提交结果失效快照（tokenVersion 已递增）", async () => {
    mocks.update.mockResolvedValue({ ...userRow, tokenVersion: 4 });

    await setUserPassword(7, "new-hash");

    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenCalledWith({ ...userRow, tokenVersion: 4 });
    // 事务内提交、提交后才失效：调用顺序由 mock 的 invocationCallOrder 固定
    expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidate.mock.invocationCallOrder[0],
    );
  });

  it("数据库更新失败时不失效快照（无提交即无陈旧状态）", async () => {
    mocks.update.mockRejectedValue(new Error("db down"));

    await expect(setUserPassword(7, "new-hash")).rejects.toThrow("db down");
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});

describe("updateUser 的失效接线", () => {
  it("写入 isActive 时提交后失效快照", async () => {
    await updateUser(7, { isActive: false });

    expect(mocks.invalidate).toHaveBeenCalledWith(userRow);
    expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidate.mock.invocationCallOrder[0],
    );
  });

  it("只改画像字段（主题 / 语言 / 头像）时不失效：它们不参与鉴权判定", async () => {
    await updateUser(7, { theme: "dark", language: "zh-CN" });

    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("事务回滚时不失效快照", async () => {
    mocks.update.mockRejectedValue(new Error("rollback"));

    await expect(updateUser(7, { isActive: false })).rejects.toThrow("rollback");
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
