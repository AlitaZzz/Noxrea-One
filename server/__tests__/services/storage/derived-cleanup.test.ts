/**
 * 派生按龄清扫直测（specs/derived-deletion-linkage.md 规则 4）：
 * 四根统一 TTL、gc_dry_run 只报不删、判龄口径（lastModifiedMs 缺失视为未到期）、
 * 失败隔离（单条删除失败留痕续行、根枚举失败不中断其余根后聚合上抛）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

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

import { DERIVED_TTL_MS, sweepStaleDerivedObjects } from "@server/services/storage/derived-cleanup";
import { resetTestSettings } from "../../helpers/settings";

const OLD_MS = Date.now() - DERIVED_TTL_MS - 60_000;
const FRESH_MS = Date.now() - 60_000;

beforeEach(() => {
  vi.clearAllMocks();
  resetTestSettings({ "storage.gc_dry_run": false });
  mocks.del.mockResolvedValue(undefined);
});

describe("sweepStaleDerivedObjects", () => {
  it("四根逐一枚举（根清单同源 DERIVED_ROOT_PREFIXES），超龄条目回收", async () => {
    mocks.list.mockImplementation(async (prefix: string) => {
      if (prefix === "_cache/") return [{ key: "_cache/64/3/ab/h.webp", size: 1, lastModifiedMs: OLD_MS }];
      if (prefix === "_sprite/") return [{ key: "_sprite/3/ab/h_c20v2.webp", size: 1, lastModifiedMs: OLD_MS }];
      return [];
    });

    await expect(sweepStaleDerivedObjects()).resolves.toBe(2);

    expect(mocks.list).toHaveBeenCalledWith("_cache/");
    expect(mocks.list).toHaveBeenCalledWith("_posters/");
    expect(mocks.list).toHaveBeenCalledWith("_sprite/");
    expect(mocks.list).toHaveBeenCalledWith("_proxy/");
    expect(mocks.del).toHaveBeenCalledTimes(2);
  });

  it("_posters 旧版本母版超龄回收（AC4：版本升级孤儿在 TTL 内清除）", async () => {
    mocks.list.mockImplementation(async (prefix: string) =>
      prefix === "_posters/"
        ? [
            { key: "_posters/v1/3/ab/old-master.webp", size: 1, lastModifiedMs: OLD_MS },
            { key: "_posters/v2/3/ab/current.webp", size: 1, lastModifiedMs: FRESH_MS },
          ]
        : [],
    );

    await expect(sweepStaleDerivedObjects()).resolves.toBe(1);
    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledWith("_posters/v1/3/ab/old-master.webp");
  });

  it("判龄口径：未到期与 lastModifiedMs 缺失（0）视为未到期，不删", async () => {
    mocks.list.mockImplementation(async (prefix: string) =>
      prefix === "_cache/"
        ? [
            { key: "fresh", size: 1, lastModifiedMs: FRESH_MS },
            { key: "no-mtime", size: 1, lastModifiedMs: 0 },
          ]
        : [],
    );

    await expect(sweepStaleDerivedObjects()).resolves.toBe(0);
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("gc_dry_run 开启：只统计不删除（与 staging 清扫同一护栏口径）", async () => {
    resetTestSettings({ "storage.gc_dry_run": true });
    mocks.list.mockImplementation(async (prefix: string) =>
      prefix === "_cache/" ? [{ key: "old", size: 1, lastModifiedMs: OLD_MS }] : [],
    );

    await expect(sweepStaleDerivedObjects()).resolves.toBe(1);
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("失败隔离：单条删除失败不中断本根，根枚举失败不中断其余根（全部根尝试后聚合上抛）", async () => {
    mocks.list.mockImplementation(async (prefix: string) => {
      if (prefix === "_cache/") {
        return [
          { key: "boom", size: 1, lastModifiedMs: OLD_MS },
          { key: "ok", size: 1, lastModifiedMs: OLD_MS },
        ];
      }
      if (prefix === "_posters/") throw new Error("list failed");
      return [];
    });
    mocks.del.mockImplementation(async (key: string) => {
      if (key === "boom") throw new Error("delete failed");
    });

    // 单条失败留痕续行（boom 仍被尝试、失败留痕；仅 "ok" 回收成功）；_posters 枚举失败
    // 不中断后续根，全部根尝试后整阶段上抛，由 GC 记录为阶段失败
    await expect(sweepStaleDerivedObjects()).rejects.toThrow("list failed");
    expect(mocks.del).toHaveBeenCalledTimes(2);
    expect(mocks.del).toHaveBeenCalledWith("boom");
    expect(mocks.del).toHaveBeenCalledWith("ok");
    expect(mocks.list).toHaveBeenCalledWith("_sprite/");
    expect(mocks.list).toHaveBeenCalledWith("_proxy/");
  });

  it("枚举失败上抛（阶段失败可见：derivedSweepError / CLI 退出码）", async () => {
    mocks.list.mockRejectedValueOnce(new Error("list down"));
    mocks.list.mockResolvedValue([]);
    await expect(sweepStaleDerivedObjects()).rejects.toThrow("list down");
    expect(mocks.del).not.toHaveBeenCalled();
  });
});
