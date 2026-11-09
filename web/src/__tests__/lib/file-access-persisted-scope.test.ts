// @vitest-environment jsdom
/**
 * 持久化命中的账号校验（specs/web-managed-media-hydration.md 2.1）：
 * 会话切换先更新账号、再依次重置各模块；命中判定必须自带账号校验，
 * 不能把「copies 会被清空」当作正确性前提。
 *
 * 本文件不导入 `@/lib/file-access`（它带会话重置监听），因此可以在
 * 「账号已更新、copies 尚未清空」的窗口里直接验证命中点。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";

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

import { subscribeAccessChanges } from "@/lib/file-access/change-signal";
import {
  persistDescriptor,
  persistedDescriptorOf,
  resetPersisted,
} from "@/lib/file-access/persisted";
import { changeSession } from "@/lib/session-lifecycle";

const KEY = makeStorageKey("persisted-scope", ".png");
const request = { key: KEY };
const accountA = "account-a";

function signedDescriptor() {
  return {
    url: "https://signed/account-a",
    delivery: "signed" as const,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

beforeEach(() => {
  storeMocks.read.mockReset().mockResolvedValue([]);
  storeMocks.write.mockReset().mockResolvedValue(undefined);
  storeMocks.remove.mockReset().mockResolvedValue(undefined);
  storeMocks.clear.mockReset().mockResolvedValue(undefined);
  resetPersisted();
  changeSession(accountA);
});

describe("持久化命中判定", () => {
  it("账号切换后旧账号副本不可命中，即使重置尚未清空 copies", () => {
    persistDescriptor(request, signedDescriptor());
    expect(persistedDescriptorOf(request)?.url).toBe("https://signed/account-a");

    // 模拟会话切换的中间窗口：账号已更新，copies 尚未被清空
    changeSession("account-b");
    expect(persistedDescriptorOf(request)).toBeNull();
  });

  it("同一账号的副本仍可命中", () => {
    persistDescriptor(request, signedDescriptor());
    changeSession(accountA);
    expect(persistedDescriptorOf(request)?.url).toBe("https://signed/account-a");
  });

  it("持久化写入本身不广播：缓存写入是描述写入的唯一通知", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAccessChanges(listener);
    try {
      persistDescriptor(request, signedDescriptor());
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
