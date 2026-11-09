/**
 * 资产库 store initialize 并发去重回归测试。
 *
 * 背景：画布门页在 React StrictMode 下 effect 双挂载，initialize 被并发调用。
 * 同步标志位守卫拦不住在途窗口，bootstrap 会真的发两次请求——
 * 在途 promise 去重后，并发调用必须共享同一次拉取。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  deleteAssetsBatch: vi.fn(),
  updateAssetsBatch: vi.fn(),
  deleteFolder: vi.fn(),
}));

vi.mock("@/entities/asset/api", () => ({
  assetApi: {
    bootstrap: (...args: unknown[]) => mocks.bootstrap(...args),
    deleteAssetsBatch: (...args: unknown[]) => mocks.deleteAssetsBatch(...args),
    updateAssetsBatch: (...args: unknown[]) => mocks.updateAssetsBatch(...args),
    deleteFolder: (...args: unknown[]) => mocks.deleteFolder(...args),
  },
}));

vi.mock("@/lib/global-notification", () => ({
  showGlobalNotification: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }),
  notifyFailure: vi.fn(),
}));

vi.mock("@/lib/i18n/config", () => ({
  default: { t: (k: string) => k, exists: () => false },
}));

import { useAssetsStore } from "@/entities/asset/store";

describe("assets store initialize 并发去重", () => {
  beforeEach(() => {
    mocks.bootstrap.mockReset();
    useAssetsStore.setState({ initialized: false, folders: [], knownAssetKeys: new Set() });
  });

  it("并发 initialize 共享同一次 bootstrap 请求", async () => {
    let resolveBootstrap!: (v: unknown) => void;
    mocks.bootstrap.mockImplementation(
      () => new Promise((resolve) => { resolveBootstrap = resolve; }),
    );

    const a = useAssetsStore.getState().initialize();
    const b = useAssetsStore.getState().initialize();
    expect(mocks.bootstrap).toHaveBeenCalledTimes(1);

    resolveBootstrap({ folders: [], fileKeys: [] });
    await Promise.all([a, b]);

    expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
    expect(useAssetsStore.getState().initialized).toBe(true);
  });

  it("失败后在途标记清空，后续 initialize 可重试", async () => {
    mocks.bootstrap.mockRejectedValueOnce(new Error("network down"));

    await useAssetsStore.getState().initialize();
    expect(useAssetsStore.getState().initialized).toBe(false);

    mocks.bootstrap.mockResolvedValue({ folders: [], fileKeys: [] });
    await useAssetsStore.getState().initialize();
    expect(useAssetsStore.getState().initialized).toBe(true);
    expect(mocks.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("已初始化后再次 initialize 不再发请求", async () => {
    mocks.bootstrap.mockResolvedValue({ folders: [], fileKeys: [] });

    await useAssetsStore.getState().initialize();
    await useAssetsStore.getState().initialize();

    expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
  });
});

describe("超限批量操作分片提交", () => {
  const counters = { total: 0 };

  beforeEach(() => {
    mocks.deleteAssetsBatch.mockReset();
    mocks.updateAssetsBatch.mockReset();
  });

  /** 超过 ASSET_BATCH_LIMIT 的批量删除按上限分片；单发超限会被服务端 422 拒绝 */
  it("批量删除 450 个资产分 3 片提交并合并计数", async () => {
    mocks.deleteAssetsBatch.mockResolvedValue({ count: 0, fileKeys: [], counters });
    const ids = Array.from({ length: 450 }, (_, i) => String(i + 1));

    const result = await useAssetsStore.getState().removeAssetsBatch(ids);

    expect(result.ok).toBe(true);
    expect(mocks.deleteAssetsBatch).toHaveBeenCalledTimes(3);
    expect(mocks.deleteAssetsBatch.mock.calls.map((call) => (call[0] as number[]).length))
      .toEqual([200, 200, 50]);
  });

  it("批量移动 450 个资产同样分片提交", async () => {
    mocks.updateAssetsBatch.mockResolvedValue({ count: 0, counters });
    const ids = Array.from({ length: 450 }, (_, i) => String(i + 1));

    const result = await useAssetsStore.getState().updateAssetsBatch(ids, { folderId: "1" });

    expect(result.ok).toBe(true);
    expect(mocks.updateAssetsBatch).toHaveBeenCalledTimes(3);
    expect(mocks.updateAssetsBatch.mock.calls.map((call) => (call[0] as number[]).length))
      .toEqual([200, 200, 50]);
  });

  it("移动分片中途失败：保留已完成分片的计数并上报失败", async () => {
    mocks.updateAssetsBatch
      .mockResolvedValueOnce({ count: 200, counters: { total: 60 } })
      .mockRejectedValueOnce(new Error("network down"));
    const ids = Array.from({ length: 450 }, (_, i) => String(i + 1));

    const result = await useAssetsStore.getState().updateAssetsBatch(ids, { folderId: "1" });

    expect(result).toMatchObject({ ok: false, total: 60 });
    expect(mocks.updateAssetsBatch).toHaveBeenCalledTimes(2);
  });

  it("删除分片中途失败：保留已完成分片的计数并上报失败", async () => {
    mocks.deleteAssetsBatch
      .mockResolvedValueOnce({ count: 200, fileKeys: [], counters: { total: 80 } })
      .mockRejectedValueOnce(new Error("network down"));
    const ids = Array.from({ length: 450 }, (_, i) => String(i + 1));

    const result = await useAssetsStore.getState().removeAssetsBatch(ids);

    expect(result).toMatchObject({ ok: false, total: 80 });
    expect(mocks.deleteAssetsBatch).toHaveBeenCalledTimes(2);
  });
});

describe("资产视图失效信号", () => {
  beforeEach(() => {
    mocks.deleteFolder.mockReset();
  });

  /** 删除文件夹会连带删除子树资产，必须与其它增删改命令一样递增 libraryVersion */
  it("删除文件夹后递增 libraryVersion 并同步移除子树与来源 key", async () => {
    mocks.deleteFolder.mockResolvedValue({
      removedCount: 2,
      fileKeys: ["k1", "k2"],
      counters: { folders: {}, total: 0 },
    });
    useAssetsStore.setState({
      folders: [
        { id: "1", name: "parent", scope: "personal", kind: "normal", createdAt: 0, count: 1 },
        { id: "2", name: "child", scope: "personal", kind: "normal", parentId: "1", createdAt: 0, count: 1 },
      ],
      knownAssetKeys: new Set(["k1", "k2"]),
      libraryVersion: 0,
    });

    const ok = await useAssetsStore.getState().removeFolder("1");

    expect(ok).toBe(true);
    expect(mocks.deleteFolder).toHaveBeenCalledWith(1);
    expect(useAssetsStore.getState().folders).toEqual([]);
    expect(useAssetsStore.getState().knownAssetKeys.size).toBe(0);
    expect(useAssetsStore.getState().libraryVersion).toBe(1);
  });
});
