/**
 * Per-user 存储配额单点单测（specs/storage-user-quota.md）：
 * 聚合口径（SUM→Number、BigInt 列安全域换算）、MB→字节换算、
 * 大小已知通道预检（边界相等放行、不限量短路不触库）、
 * 二元门槛（0=不限量永不触发、恰好占满拒绝）、
 * me 摘要序列化（配置哨兵 0 → null，不出配置域）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@server/core/database/client", () => ({
  prisma: { fileObject: { findUnique: mocks.findUnique, aggregate: mocks.aggregate } },
}));
vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());

import {
  findQuotaGateViolation,
  findQuotaViolation,
  getQuotaBytes,
  getStorageSummary,
  getUserUsage,
} from "@server/services/storage/quota";
import { resetTestSettings } from "../../helpers/settings";

const MB = 1024 * 1024;

beforeEach(() => {
  vi.clearAllMocks();
  resetTestSettings();
  mocks.aggregate.mockResolvedValue({ _sum: { size: null } });
  mocks.findUnique.mockResolvedValue(null);
});

describe("getUserUsage", () => {
  it("按用户 SUM(size) 聚合，BigInt 转 Number", async () => {
    mocks.aggregate.mockResolvedValueOnce({ _sum: { size: 1234n } });
    await expect(getUserUsage(7)).resolves.toBe(1234);
    expect(mocks.aggregate.mock.calls[0][0]).toEqual({ _sum: { size: true }, where: { userId: 7 } });
  });

  it("无行（SUM 为 null）按 0 计", async () => {
    await expect(getUserUsage(7)).resolves.toBe(0);
  });
});

describe("getQuotaBytes", () => {
  it("MB 值换算为字节", () => {
    resetTestSettings({ "storage.quota.default_mb": 2 });
    expect(getQuotaBytes()).toBe(2 * MB);
  });

  it("不限量哨兵 0 即 0 字节", () => {
    expect(getQuotaBytes()).toBe(0);
  });
});

describe("findQuotaViolation（大小已知通道）", () => {
  it("不限量（0）短路放行，不触库", async () => {
    await expect(findQuotaViolation(7, 100)).resolves.toBeNull();
    expect(mocks.aggregate).not.toHaveBeenCalled();
  });

  it("已用 + 增量 > 配额：返回用量上下文", async () => {
    resetTestSettings({ "storage.quota.default_mb": 1 });
    mocks.aggregate.mockResolvedValueOnce({ _sum: { size: BigInt(819200) } });
    await expect(findQuotaViolation(7, 300000)).resolves.toEqual({
      usedBytes: 819200,
      quotaBytes: MB,
    });
  });

  it("边界相等（used + size == quota）放行", async () => {
    resetTestSettings({ "storage.quota.default_mb": 1 });
    mocks.aggregate.mockResolvedValueOnce({ _sum: { size: BigInt(MB - 5) } });
    await expect(findQuotaViolation(7, 5)).resolves.toBeNull();
  });

  it("BigInt 大值：MAX_SAFE_INTEGER 量级精确换算；注册表上限处边界相等放行（验收标准 4）", async () => {
    mocks.aggregate.mockResolvedValueOnce({ _sum: { size: BigInt(Number.MAX_SAFE_INTEGER) } });
    await expect(getUserUsage(7)).resolves.toBe(Number.MAX_SAFE_INTEGER);

    // registry 上限 MB（MAX_SAFE_INTEGER / 1024² 向下取整 = 8589934591）换算字节 = 2^53 − 2^20，安全域内
    resetTestSettings({ "storage.quota.default_mb": 8589934591 });
    mocks.aggregate.mockResolvedValueOnce({ _sum: { size: BigInt(9007198206162944 - 5) } });
    await expect(findQuotaViolation(7, 5)).resolves.toBeNull();
  });

  it("幂等重添加豁免：dedupeHash 命中既有行放行，不触聚合查询", async () => {
    resetTestSettings({ "storage.quota.default_mb": 1 });
    // 用量已恰好占满：无豁免即拒绝，豁免后放行构成有效判别
    mocks.findUnique.mockResolvedValueOnce({ userId: 7, hash: "h", size: BigInt(100) });
    await expect(findQuotaViolation(7, 5, { dedupeHash: "h" })).resolves.toBeNull();
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { userId_hash: { userId: 7, hash: "h" } },
    });
    expect(mocks.aggregate).not.toHaveBeenCalled();
  });

  it("dedupeHash 未命中（净增内容）：正常判定并携带用量上下文", async () => {
    resetTestSettings({ "storage.quota.default_mb": 1 });
    mocks.findUnique.mockResolvedValueOnce(null);
    mocks.aggregate.mockResolvedValueOnce({ _sum: { size: BigInt(819200) } });
    await expect(findQuotaViolation(7, 300000, { dedupeHash: "h" })).resolves.toEqual({
      usedBytes: 819200,
      quotaBytes: MB,
    });
  });
});

describe("findQuotaGateViolation（大小未知通道二元门槛）", () => {
  it("不限量（0）永不触发，不触库", async () => {
    await expect(findQuotaGateViolation(7)).resolves.toBeNull();
    expect(mocks.aggregate).not.toHaveBeenCalled();
  });

  it("恰好占满（used == quota）拒绝：增量写入已无空间", async () => {
    resetTestSettings({ "storage.quota.default_mb": 1 });
    mocks.aggregate.mockResolvedValueOnce({ _sum: { size: BigInt(MB) } });
    await expect(findQuotaGateViolation(7)).resolves.toEqual({ usedBytes: MB, quotaBytes: MB });
  });

  it("仍有余量（used < quota）放行", async () => {
    resetTestSettings({ "storage.quota.default_mb": 1 });
    mocks.aggregate.mockResolvedValueOnce({ _sum: { size: BigInt(MB - 1) } });
    await expect(findQuotaGateViolation(7)).resolves.toBeNull();
  });
});

describe("getStorageSummary（me 响应摘要）", () => {
  it("限量：quotaBytes 为换算后的字节数", async () => {
    resetTestSettings({ "storage.quota.default_mb": 2 });
    mocks.aggregate.mockResolvedValueOnce({ _sum: { size: 1000n } });
    await expect(getStorageSummary(7)).resolves.toEqual({ usedBytes: 1000, quotaBytes: 2 * MB });
  });

  it("不限量：配置哨兵 0 转译为 null，不出配置域", async () => {
    mocks.aggregate.mockResolvedValueOnce({ _sum: { size: 1000n } });
    await expect(getStorageSummary(7)).resolves.toEqual({ usedBytes: 1000, quotaBytes: null });
  });
});
