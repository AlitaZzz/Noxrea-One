/**
 * 修改密码用例的事务编排（specs/auth-request-verification.md 规则 4.2 / 4.5）。
 * 锁定：画像与密码在同一事务内提交、密码写入后才失效鉴权快照，
 * 以及头像校验失败时密码不被单独写入、快照不失效。
 * 失效本身的行为由 `core/auth/snapshot.test.ts` 覆盖，这里只断言接线，因此 mock 掉
 * 快照模块、事务与 crud 原语，不依赖真实库。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  updateUserPasswordTx: vi.fn(),
  updateUserTx: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@server/core/database/transaction", () => ({
  withTransaction: mocks.withTransaction,
}));
vi.mock("@server/crud/user", () => ({
  updateUserPasswordTx: mocks.updateUserPasswordTx,
  updateUserFieldsTx: vi.fn(),
}));
// 只替换实际写库的事务原语，保留真实 hasProfileFields：
// 「空画像跳过写入」的判定必须与生产白名单同源，不能用测试桩复述规则。
vi.mock("@server/services/user/update-profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@server/services/user/update-profile")>();
  return { hasProfileFields: actual.hasProfileFields, updateUserTx: mocks.updateUserTx };
});
vi.mock("@server/core/auth/snapshot", () => ({ invalidateAuthSnapshot: mocks.invalidate }));

import { changePassword } from "@server/services/user/change-password";

/** 用户行：失效入参取的是写入后的行，因此每行都带 id / isActive / tokenVersion */
const userRow = { id: 7, isActive: true, tokenVersion: 3 };
const TX = { name: "tx", $queryRaw: vi.fn(async () => []) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => fn(TX),
  );
  mocks.updateUserPasswordTx.mockResolvedValue(userRow);
});

describe("changePassword", () => {
  it("仅改密码：写入成功后以写入结果失效快照（tokenVersion 已递增）", async () => {
    mocks.updateUserPasswordTx.mockResolvedValue({ ...userRow, tokenVersion: 4 });

    await changePassword(7, "new-hash");

    expect(mocks.updateUserTx).not.toHaveBeenCalled();
    expect(mocks.updateUserPasswordTx).toHaveBeenCalledWith(TX, 7, "new-hash");
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenCalledWith({ ...userRow, tokenVersion: 4 });
    // 写库完成后才失效：调用顺序由 mock 的 invocationCallOrder 固定
    expect(mocks.updateUserPasswordTx.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidate.mock.invocationCallOrder[0],
    );
  });

  it("密码与画像同改：画像先于密码写入同一事务", async () => {
    await changePassword(7, "new-hash", { avatarKey: null, theme: "dark" });

    expect(mocks.updateUserTx).toHaveBeenCalledWith(TX, 7, { avatarKey: null, theme: "dark" });
    expect(mocks.updateUserPasswordTx).toHaveBeenCalledWith(TX, 7, "new-hash");
    expect(mocks.updateUserTx.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateUserPasswordTx.mock.invocationCallOrder[0],
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(userRow);
  });

  it("画像字段全部未定义：不发起空更新", async () => {
    await changePassword(7, "new-hash", { theme: undefined, avatarKey: undefined });

    expect(mocks.updateUserTx).not.toHaveBeenCalled();
    expect(mocks.updateUserPasswordTx).toHaveBeenCalledWith(TX, 7, "new-hash");
  });

  it("头像校验失败：事务拒绝，密码不写入且快照不失效", async () => {
    mocks.updateUserTx.mockRejectedValue(new Error("invalid avatar"));

    await expect(
      changePassword(7, "new-hash", { avatarKey: "https://example.com/a.png" }),
    ).rejects.toThrow("invalid avatar");

    expect(mocks.updateUserPasswordTx).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("数据库更新失败时不失效快照（无提交即无陈旧状态）", async () => {
    mocks.updateUserPasswordTx.mockRejectedValue(new Error("db down"));

    await expect(changePassword(7, "new-hash")).rejects.toThrow("db down");
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
