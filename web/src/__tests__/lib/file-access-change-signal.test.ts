// @vitest-environment jsdom
/**
 * 访问解析的变更信号（specs/web-managed-media-hydration.md 2.1）：
 * 缓存写入 / 持久化载入 / 形态学习 / 会话重置必须通知订阅者。
 * 解析层只提供同步读取，快照的引用稳定性由消费方按源冻结
 * （见 UseFileAccessUrl.test.tsx「无关媒体的缓存写入不重渲染已挂载的 Hook」）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";

vi.mock("@/lib/api/client", () => ({ api: vi.fn(), ApiError: class ApiError extends Error {} }));

const storeMocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("@/lib/file-access-store", () => ({
  readPersistedDescriptors: storeMocks.read,
  writePersistedDescriptors: storeMocks.write,
  deletePersistedDescriptors: storeMocks.remove,
  clearPersistedDescriptors: storeMocks.clear,
}));

import { peekMediaAccess, subscribeAccessChanges } from "@/lib/file-access";
import { resetCache, storeIfNewer } from "@/lib/file-access/cache";
import { cacheKeyOf } from "@/lib/file-access/protocol";
import { currentScope, learnStreamDelivery } from "@/lib/file-access/state";
import { changeSession } from "@/lib/session-lifecycle";

const ACCOUNT = "42";
const KEY = makeStorageKey("signal-a", ".png");
const KEY_B = makeStorageKey("signal-b", ".png");
const cacheKey = () => cacheKeyOf(currentScope(), { key: KEY });
const cacheKeyB = () => cacheKeyOf(currentScope(), { key: KEY_B });

const nowSeconds = () => Math.floor(Date.now() / 1000);
const EXPIRES = nowSeconds() + 3600;
const REFRESH = nowSeconds() + 3000;

function signed(url: string, expiresAt = EXPIRES, refreshAt = REFRESH) {
  return { url, delivery: "signed" as const, expiresAt, refreshAt };
}

function persistedRecord(url: string) {
  return {
    cacheKey: `${KEY}\u0000`,
    scope: ACCOUNT,
    url,
    expiresAt: nowSeconds() + 3600,
    refreshAt: nowSeconds() + 3000,
    savedAt: Date.now(),
  };
}

beforeEach(() => {
  storeMocks.read.mockReset().mockResolvedValue([]);
  storeMocks.write.mockReset().mockResolvedValue(undefined);
  storeMocks.remove.mockReset().mockResolvedValue(undefined);
  storeMocks.clear.mockReset().mockResolvedValue(undefined);
  changeSession();
});

describe("访问解析变更信号", () => {
  it("缓存写入通知订阅者，同步读取立即可用", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAccessChanges(listener);
    expect(peekMediaAccess(KEY)).toBeNull();

    storeIfNewer(cacheKey(), 1, signed("https://signed/a"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(peekMediaAccess(KEY)).toEqual({
      url: "https://signed/a",
      delivery: "signed",
      expiresAt: EXPIRES,
      refreshAt: REFRESH,
    });

    // 信号是全局的：无关 key 的写入同样通知，是否重渲染由订阅方按源比较决定
    storeIfNewer(cacheKeyB(), 1, signed("https://signed/b"));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(peekMediaAccess(KEY)?.url).toBe("https://signed/a");
    unsubscribe();
  });

  it("同一 key 的描述更新后同步读取返回新地址", () => {
    storeIfNewer(cacheKey(), 1, signed("https://signed/a"));
    expect(peekMediaAccess(KEY)?.url).toBe("https://signed/a");

    storeIfNewer(cacheKey(), 2, signed("https://signed/a2"));
    expect(peekMediaAccess(KEY)?.url).toBe("https://signed/a2");
  });

  it("会话重置清空旧账号缓存并通知，新作用域只读到新写入", () => {
    storeIfNewer(cacheKey(), 1, signed("https://signed/a"));
    const listener = vi.fn();
    const unsubscribe = subscribeAccessChanges(listener);
    changeSession(ACCOUNT);

    expect(listener).toHaveBeenCalled();
    // 解析层不保留派生结果：缓存清空后同步读取不再返回旧账号的签名地址
    expect(peekMediaAccess(KEY)).toBeNull();

    storeIfNewer(cacheKey(), 2, signed("https://signed/a"));
    expect(peekMediaAccess(KEY)?.url).toBe("https://signed/a");
    unsubscribe();
  });

  it("stream 形态学习通知订阅者，并由逻辑值直接构造读取结果", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAccessChanges(listener);

    learnStreamDelivery();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(peekMediaAccess(KEY)).toEqual({
      url: `/api/files/${KEY}`,
      delivery: "stream",
    });

    // 已学习后再学习不重复通知
    learnStreamDelivery();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("持久化载入通知订阅者，载入后的读取立即可用", async () => {
    storeMocks.read.mockResolvedValue([persistedRecord("https://signed/persisted")]);
    changeSession(ACCOUNT);
    // 会话重置自身已通知过；从载入完成前开始订阅，只观察持久化载入这一次
    const listener = vi.fn();
    const unsubscribe = subscribeAccessChanges(listener);

    await vi.waitFor(() => {
      expect(peekMediaAccess(KEY)?.url).toBe("https://signed/persisted");
    });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("缓存重置通知订阅者", () => {
    storeIfNewer(cacheKey(), 1, signed("https://signed/a"));
    const listener = vi.fn();
    const unsubscribe = subscribeAccessChanges(listener);

    resetCache();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(peekMediaAccess(KEY)).toBeNull();
    unsubscribe();
  });
});
