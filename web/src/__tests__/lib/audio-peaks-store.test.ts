/**
 * 峰值持久层（specs/canvas-audio-peaks-cache.md 规则 3）。
 *
 * `audio-peaks.test.ts` 把 store 整体替身化以验证服务编排；这里用 mock 的 `idb`
 * 验证 store 自身的降级边界：IDB 不可用、读写异常与形状不符的记录都必须退化为
 * 「无持久化」或「未命中」，不得抛出（规则 3.6）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PeaksRecord } from "@/lib/audio-peaks/store";

const { openDB } = vi.hoisted(() => ({ openDB: vi.fn() }));
vi.mock("idb", () => ({ openDB }));

const KEY = "1/aa/a.mp3";

interface FakeConnection {
  get: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
}

function connection(patch: Partial<FakeConnection> = {}): FakeConnection {
  return {
    get: vi.fn(),
    transaction: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    ...patch,
  };
}

function validRecord(): PeaksRecord {
  return {
    key: KEY,
    channels: [new Float32Array([0.1, 0.2])],
    duration: 1,
    savedAt: 1,
    lastUsedAt: 1,
  };
}

/** 畸形记录：形状字段可任意替换 */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...validRecord(), ...overrides };
}

/** 每个用例拿一份新模块：store.ts 的数据库 Promise 是模块级缓存 */
async function loadStore(): Promise<typeof import("@/lib/audio-peaks/store")> {
  vi.resetModules();
  return import("@/lib/audio-peaks/store");
}

beforeEach(() => {
  openDB.mockReset();
  vi.stubGlobal("indexedDB", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IndexedDB 不可用（规则 3.6）", () => {
  it("openDB 失败时读写都退化为无持久化且不抛出", async () => {
    openDB.mockRejectedValue(new Error("blocked"));
    const store = await loadStore();

    expect(await store.readPeaks(KEY)).toBeNull();
    await expect(store.writePeaks(validRecord())).resolves.toBeUndefined();
    await expect(store.touchPeaks(KEY, 2)).resolves.toBeUndefined();
    // 失败结果被缓存：后续调用不再重试 openDB
    expect(openDB).toHaveBeenCalledTimes(1);
  });
});

describe("读写异常降级（规则 3.6）", () => {
  it("读取异常按未命中处理", async () => {
    openDB.mockResolvedValue(connection({ get: vi.fn().mockRejectedValue(new Error("read")) }) as never);
    const store = await loadStore();

    expect(await store.readPeaks(KEY)).toBeNull();
  });

  it("写入异常不向调用方抛出", async () => {
    openDB.mockResolvedValue(connection({
      transaction: vi.fn(() => ({
        store: { put: vi.fn() },
        done: Promise.reject(new Error("quota")),
      })),
    }) as never);
    const store = await loadStore();

    await expect(store.writePeaks(validRecord())).resolves.toBeUndefined();
  });

  it("淘汰异常只多留条目，写入仍成功", async () => {
    openDB.mockResolvedValue(connection({
      transaction: vi.fn(() => ({
        store: { put: vi.fn() },
        done: Promise.resolve(),
      })),
      count: vi.fn().mockRejectedValue(new Error("count")),
    }) as never);
    const store = await loadStore();

    await expect(store.writePeaks(validRecord())).resolves.toBeUndefined();
  });

  it("刷新使用时刻异常不影响命中", async () => {
    openDB.mockResolvedValue(connection({
      transaction: vi.fn(() => ({
        store: { get: vi.fn().mockRejectedValue(new Error("touch")) },
        done: Promise.resolve(),
      })),
    }) as never);
    const store = await loadStore();

    await expect(store.touchPeaks(KEY, 2)).resolves.toBeUndefined();
  });
});

describe("记录形状校验（规则 3.2 / 3.6）", () => {
  it("形状正确的记录原样返回", async () => {
    const valid = validRecord();
    openDB.mockResolvedValue(connection({ get: vi.fn().mockResolvedValue(valid) }) as never);
    const store = await loadStore();

    expect(await store.readPeaks(KEY)).toEqual(valid);
  });

  it("形状不符或主键不一致的记录按未命中处理", async () => {
    const invalid = [
      null,
      record({ key: "1/bb/b.mp3" }),
      record({ channels: null }),
      record({ channels: [] }),
      record({ channels: [new Float32Array(0)] }),
      record({ channels: [new Uint8Array(2)] }),
      record({ duration: Number.NaN }),
      record({ duration: 0 }),
      record({ savedAt: Number.NaN }),
      record({ lastUsedAt: "1" }),
    ];

    for (const value of invalid) {
      openDB.mockResolvedValue(connection({ get: vi.fn().mockResolvedValue(value) }) as never);
      const store = await loadStore();
      expect(await store.readPeaks(KEY)).toBeNull();
    }
  });

  it("刷新使用时刻遇到形状不符的记录时不回写", async () => {
    const put = vi.fn();
    openDB.mockResolvedValue(connection({
      transaction: vi.fn(() => ({
        store: {
          get: vi.fn().mockResolvedValue(record({ channels: null })),
          put,
        },
        done: Promise.resolve(),
      })),
    }) as never);
    const store = await loadStore();

    await store.touchPeaks(KEY, 2);
    expect(put).not.toHaveBeenCalled();
  });
});
