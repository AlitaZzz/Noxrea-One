/**
 * 启动探测残留清扫直测（specs/storage-provider-portability.md 规则 3.2）：
 * 只扫 `_probe/`、固定 24h 判龄（lastModifiedMs 缺失视为未到期）、
 * gc_dry_run 只报不删、枚举失败上抛由 GC 记为阶段失败。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  del: vi.fn(),
  getConfig: vi.fn().mockReturnValue({ LOG_LEVEL: "silent" }),
}));

vi.mock("@server/core/config", () => ({ getConfig: mocks.getConfig }));
vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());
vi.mock("@server/core/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@server/services/storage/service", () => ({
  getStorageBackend: () => ({ list: mocks.list, delete: mocks.del }),
}));

import { hoursToMs } from "@server/core/duration";
import { sweepStaleProbeObjects } from "@server/services/storage/probe-cleanup";
import { resetTestSettings } from "../../helpers/settings";

/** 以 24h TTL 之外的 1 分钟作为“确定超龄”样本，避免贴近边界 */
const oldMs = () => Date.now() - hoursToMs(24) - 60_000;
const FRESH_MS = Date.now() - 60_000;

beforeEach(() => {
  vi.clearAllMocks();
  resetTestSettings({ "storage.gc_dry_run": false });
  mocks.del.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([]);
});

describe("sweepStaleProbeObjects", () => {
  it("只枚举 _probe/，超龄残留回收", async () => {
    mocks.list.mockResolvedValue([
      { key: "_probe/11111111-1111-4111-8111-111111111111.txt", size: 1024, lastModifiedMs: oldMs() },
    ]);

    await expect(sweepStaleProbeObjects()).resolves.toBe(1);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith("_probe/");
    expect(mocks.del).toHaveBeenCalledWith("_probe/11111111-1111-4111-8111-111111111111.txt");
  });

  it("判龄口径：未到期与 lastModifiedMs 缺失（0）视为未到期，不删", async () => {
    mocks.list.mockResolvedValue([
      { key: "_probe/fresh.txt", size: 1024, lastModifiedMs: FRESH_MS },
      { key: "_probe/no-mtime.txt", size: 1024, lastModifiedMs: 0 },
    ]);

    await expect(sweepStaleProbeObjects()).resolves.toBe(0);
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("gc_dry_run 开启：只统计不删除（与其余清扫同一护栏口径）", async () => {
    resetTestSettings({ "storage.gc_dry_run": true });
    mocks.list.mockResolvedValue([
      { key: "_probe/old.txt", size: 1024, lastModifiedMs: oldMs() },
    ]);

    await expect(sweepStaleProbeObjects()).resolves.toBe(1);
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("枚举失败上抛（阶段失败可见：probeSweepError / CLI 退出码）", async () => {
    mocks.list.mockRejectedValue(new Error("list down"));

    await expect(sweepStaleProbeObjects()).rejects.toThrow("list down");
    expect(mocks.del).not.toHaveBeenCalled();
  });
});
