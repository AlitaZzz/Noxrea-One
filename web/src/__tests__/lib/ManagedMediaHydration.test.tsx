// @vitest-environment jsdom
/**
 * 托管媒体水合一致性（specs/web-managed-media-hydration.md）：
 * 持久化签名描述已载入时，SSR 与水合首帧仍必须同为「未解析」，
 * 水合完成后才能使用客户端缓存出图，并且不重新请求描述接口。
 */
import { act } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ api: mocks.api, ApiError: class ApiError extends Error {} }));

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

import { ResolvedImage } from "@/components/media/ResolvedMedia";
import { peekMediaAccess } from "@/lib/file-access";
import { resetProactiveRefresh } from "@/lib/file-access/proactive";
import { changeSession } from "@/lib/session-lifecycle";

const ACCOUNT = "42";
const KEY = makeStorageKey("hydration-avatar", ".png");
const SIGNED_URL = "https://signed/hydrated-avatar";

const nowSeconds = () => Math.floor(Date.now() / 1000);

function persistedRecord() {
  return {
    cacheKey: `${KEY}\u0000`,
    scope: ACCOUNT,
    url: SIGNED_URL,
    expiresAt: nowSeconds() + 3600,
    refreshAt: nowSeconds() + 3000,
    savedAt: Date.now(),
  };
}

function media() {
  return <ResolvedImage value={KEY} alt="avatar" fallback={<span>fallback</span>} />;
}

/** React 19 把水合不匹配作为 recoverable error 上报；显式接收可避免 jsdom 抛成未处理异常 */
function recoverableMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

beforeEach(() => {
  mocks.api.mockReset();
  storeMocks.read.mockReset().mockResolvedValue([]);
  storeMocks.write.mockReset().mockResolvedValue(undefined);
  storeMocks.remove.mockReset().mockResolvedValue(undefined);
  storeMocks.clear.mockReset().mockResolvedValue(undefined);
  changeSession();
});

afterEach(() => {
  resetProactiveRefresh();
  vi.restoreAllMocks();
});

describe("托管媒体水合一致性", () => {
  it("持久化描述已载入时，SSR 与水合首帧一致，水合后命中缓存且不发描述请求", async () => {
    // 服务端：无账号、无持久化副本，只输出 fallback
    const serverHtml = renderToString(media());
    expect(serverHtml).toContain("fallback");
    expect(serverHtml).not.toContain(SIGNED_URL);

    // 客户端：账号作用域建立，持久化副本在水合前载入（与真实赛跑中命中的时序一致）
    storeMocks.read.mockResolvedValue([persistedRecord()]);
    changeSession(ACCOUNT);
    await vi.waitFor(() => {
      expect(peekMediaAccess(KEY)?.url).toBe(SIGNED_URL);
    });
    // 即使客户端缓存已预热，服务端快照也必须仍是未解析（不能把客户端缓存带进水合基线）
    const warmServerHtml = renderToString(media());
    expect(warmServerHtml).toContain("fallback");
    expect(warmServerHtml).not.toContain(SIGNED_URL);

    const recoverableErrors: unknown[] = [];
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    let root!: Root;
    await act(async () => {
      root = hydrateRoot(container, media(), {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });

    await vi.waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe(SIGNED_URL);
    });
    expect(recoverableErrors.map(recoverableMessage)).toEqual([]);
    expect(mocks.api).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });
});
