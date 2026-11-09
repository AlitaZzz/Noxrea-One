/**
 * 用户资料更新用例测试（specs/server-crud-service-boundary.md 第 3 节）。
 * 锁定：字段白名单、头像校验链（先验后写）、账本整替同事务、提交后鉴权快照失效，
 * 以及事务内只经 crud 原语触达单表。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  updateUserFieldsTx: vi.fn(),
  hasFileObjectTx: vi.fn(),
  replaceSourceFileRefTx: vi.fn(),
  invalidate: vi.fn(),
  isKeyOwner: vi.fn(),
}));

vi.mock("@server/core/database/transaction", () => ({
  withTransaction: mocks.withTransaction,
}));
vi.mock("@server/crud/user", () => ({
  updateUserFieldsTx: mocks.updateUserFieldsTx,
}));
vi.mock("@server/crud/file", () => ({
  hasFileObjectTx: mocks.hasFileObjectTx,
}));
vi.mock("@server/crud/file-ref-ledger", () => ({
  replaceSourceFileRefTx: mocks.replaceSourceFileRefTx,
}));
vi.mock("@server/core/auth/snapshot", () => ({
  invalidateAuthSnapshot: mocks.invalidate,
}));
vi.mock("@server/services/storage/ownership", () => ({
  isKeyOwner: mocks.isKeyOwner,
}));

import { updateUser, UserAvatarKeyError } from "@server/services/user/update-profile";

const HASH = "a".repeat(64);
const AVATAR_KEY = `7/${HASH.slice(0, 2)}/${HASH}.png`;
const TX = { name: "tx" };
const userRow = { id: 7, isActive: true, tokenVersion: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => fn(TX),
  );
  mocks.updateUserFieldsTx.mockResolvedValue(userRow);
  mocks.hasFileObjectTx.mockResolvedValue(true);
  mocks.isKeyOwner.mockReturnValue(true);
});

describe("字段白名单", () => {
  it("白名单外字段被丢弃，仅透传画像字段", async () => {
    await updateUser(7, {
      theme: "light",
      hashedPassword: "evil",
      role: "admin",
    } as Parameters<typeof updateUser>[1]);

    expect(mocks.updateUserFieldsTx).toHaveBeenCalledWith(TX, 7, { theme: "light" });
  });
});

describe("头像校验链（先验后写）", () => {
  it("合法 key：校验归属与对象存在性后才写行，并同事务整替账本", async () => {
    await updateUser(7, { avatarKey: AVATAR_KEY });

    expect(mocks.isKeyOwner).toHaveBeenCalledWith(AVATAR_KEY, 7);
    expect(mocks.hasFileObjectTx).toHaveBeenCalledWith(TX, 7, HASH);
    expect(mocks.updateUserFieldsTx).toHaveBeenCalledWith(TX, 7, { avatarKey: AVATAR_KEY });
    expect(mocks.replaceSourceFileRefTx).toHaveBeenCalledWith(
      TX,
      { userId: 7, sourceType: "avatar", sourceId: "7" },
      AVATAR_KEY,
    );
    // 校验先于写库
    expect(mocks.hasFileObjectTx.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateUserFieldsTx.mock.invocationCallOrder[0],
    );
    expect(mocks.replaceSourceFileRefTx.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.updateUserFieldsTx.mock.invocationCallOrder[0],
    );
  });

  it("非存储 key 形态（外部 URL）：写库前抛 UserAvatarKeyError", async () => {
    await expect(
      updateUser(7, { avatarKey: "https://example.com/a.png" }),
    ).rejects.toBeInstanceOf(UserAvatarKeyError);

    expect(mocks.updateUserFieldsTx).not.toHaveBeenCalled();
    expect(mocks.hasFileObjectTx).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefTx).not.toHaveBeenCalled();
  });

  it("key 内嵌属主不是当前用户：写库前抛 UserAvatarKeyError", async () => {
    mocks.isKeyOwner.mockReturnValue(false);

    await expect(updateUser(7, { avatarKey: AVATAR_KEY })).rejects.toBeInstanceOf(
      UserAvatarKeyError,
    );

    expect(mocks.hasFileObjectTx).not.toHaveBeenCalled();
    expect(mocks.updateUserFieldsTx).not.toHaveBeenCalled();
  });

  it("对象行缺失：写库前抛 UserAvatarKeyError，不造惰性聚合行", async () => {
    mocks.hasFileObjectTx.mockResolvedValue(false);

    await expect(updateUser(7, { avatarKey: AVATAR_KEY })).rejects.toBeInstanceOf(
      UserAvatarKeyError,
    );

    expect(mocks.updateUserFieldsTx).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefTx).not.toHaveBeenCalled();
  });

  it("avatarKey=null 表示清空：跳过解析与存在性校验，账本整替传入 null", async () => {
    await updateUser(7, { avatarKey: null });

    expect(mocks.hasFileObjectTx).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefTx).toHaveBeenCalledWith(
      TX,
      { userId: 7, sourceType: "avatar", sourceId: "7" },
      null,
    );
  });

  it("未携带 avatarKey：不触碰头像账本", async () => {
    await updateUser(7, { theme: "dark" });

    expect(mocks.hasFileObjectTx).not.toHaveBeenCalled();
    expect(mocks.replaceSourceFileRefTx).not.toHaveBeenCalled();
  });
});

describe("提交后鉴权快照失效", () => {
  it("写入 isActive 时提交后失效快照", async () => {
    await updateUser(7, { isActive: false });

    expect(mocks.updateUserFieldsTx).toHaveBeenCalledWith(TX, 7, { isActive: false });
    expect(mocks.invalidate).toHaveBeenCalledWith(userRow);
    expect(mocks.updateUserFieldsTx.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidate.mock.invocationCallOrder[0],
    );
  });

  it("只改画像字段（主题 / 语言 / 头像）时不失效：它们不参与鉴权判定", async () => {
    await updateUser(7, { theme: "dark", language: "zh-CN", avatarKey: AVATAR_KEY });

    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("事务回滚时不失效快照", async () => {
    mocks.updateUserFieldsTx.mockRejectedValue(new Error("rollback"));

    await expect(updateUser(7, { isActive: false })).rejects.toThrow("rollback");
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
