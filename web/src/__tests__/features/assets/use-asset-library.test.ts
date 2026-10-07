// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchAssetPage = vi.hoisted(() => vi.fn());
const encodeAssetCursor = vi.hoisted(() => vi.fn());

vi.mock("@/features/assets/store", () => ({
  ASSET_PAGE_SIZE: 50,
  encodeAssetCursor,
  fetchAssetPage,
}));

import { useAssetLibrary } from "@/features/assets/hooks/use-asset-library";
import type { AssetItem } from "@/features/assets/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function asset(id: string): AssetItem {
  return {
    id,
    name: id,
    type: "other",
    mediaType: "image",
    width: 100,
    height: 100,
    size: 1,
    duration: 0,
    description: "",
    createdAt: 1,
    updatedAt: 1,
    tags: [],
    prompt: "",
    folderId: "1",
    scope: "personal",
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useAssetLibrary request invalidation", () => {
  it("does not let an already queued reload response restore a deleted item", async () => {
    const first = asset("a");
    const second = asset("b");
    const staleReload = deferred<{ items: AssetItem[]; total: number; nextCursor: string | null }>();
    fetchAssetPage
      .mockResolvedValueOnce({ items: [first, second], total: 2, nextCursor: null })
      .mockImplementationOnce(() => staleReload.promise);

    const { result } = renderHook(() => useAssetLibrary({
      enabled: true,
      scope: "personal",
      folderId: "1",
      search: "",
      categories: [],
    }));

    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(["a", "b"]));
    act(() => result.current.reload());
    await waitFor(() => expect(fetchAssetPage).toHaveBeenCalledTimes(2));

    await act(async () => {
      await result.current.removeItems([first.id]);
    });
    expect(result.current.items.map((item) => item.id)).toEqual(["b"]);

    await act(async () => {
      staleReload.resolve({ items: [first, second], total: 2, nextCursor: null });
      await staleReload.promise;
    });
    expect(result.current.items.map((item) => item.id)).toEqual(["b"]);
  });

  it("does not let the pagination sentinel replace a pending same-query reload", async () => {
    const first = asset("a");
    const second = asset("b");
    const reload = deferred<{ items: AssetItem[]; total: number; nextCursor: string | null }>();
    fetchAssetPage
      .mockResolvedValueOnce({ items: [first], total: 2, nextCursor: "cursor" })
      .mockImplementationOnce(() => reload.promise)
      .mockResolvedValueOnce({ items: [second], total: 2, nextCursor: null });

    const { result } = renderHook(() => useAssetLibrary({
      enabled: true,
      scope: "personal",
      folderId: "1",
      search: "",
      categories: [],
    }));

    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(["a"]));
    act(() => result.current.reload());
    await waitFor(() => expect(fetchAssetPage).toHaveBeenCalledTimes(2));
    act(() => result.current.loadMore());
    expect(fetchAssetPage).toHaveBeenCalledTimes(2);

    await act(async () => {
      reload.resolve({ items: [first], total: 2, nextCursor: "cursor" });
      await reload.promise;
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.loadMore());
    await waitFor(() => expect(fetchAssetPage).toHaveBeenCalledTimes(3));
  });

  it("stops pagination when deletion refill reaches the server-reported last page", async () => {
    const first = asset("a");
    const deleted = asset("b");
    const replacement = asset("c");
    encodeAssetCursor.mockReturnValue("after-a");
    fetchAssetPage
      .mockResolvedValueOnce({ items: [first, deleted], total: 3, nextCursor: "page-2" })
      .mockResolvedValueOnce({ items: [replacement], total: 2, nextCursor: null });

    const { result } = renderHook(() => useAssetLibrary({
      enabled: true,
      scope: "personal",
      folderId: "1",
      search: "",
      categories: [],
    }));

    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(["a", "b"]));

    await act(async () => {
      await result.current.removeItems([deleted.id]);
    });

    expect(result.current.items.map((item) => item.id)).toEqual(["a", "c"]);
    expect(result.current.hasMore).toBe(false);
    expect(fetchAssetPage).toHaveBeenCalledTimes(2);

    act(() => result.current.loadMore());
    expect(fetchAssetPage).toHaveBeenCalledTimes(2);
  });
});
