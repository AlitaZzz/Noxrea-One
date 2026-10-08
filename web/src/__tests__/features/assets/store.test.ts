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
}));

vi.mock("@/features/assets/api", () => ({
  ASSET_BATCH_LIMIT: 50,
  assetApi: {
    bootstrap: (...args: unknown[]) => mocks.bootstrap(...args),
  },
}));

vi.mock("@/lib/global-notification", () => ({
  showGlobalNotification: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

vi.mock("@/lib/i18n/config", () => ({
  default: { t: (k: string) => k, exists: () => false },
}));

import { selectChildFolders, useAssetsStore } from "@/features/assets/store";

describe("assets store initialize 并发去重", () => {
  beforeEach(() => {
    mocks.bootstrap.mockReset();
    useAssetsStore.setState({ initialized: false, folders: [], knownAssetUrls: new Set() });
  });

  it("并发 initialize 共享同一次 bootstrap 请求", async () => {
    let resolveBootstrap!: (v: unknown) => void;
    mocks.bootstrap.mockImplementation(
      () => new Promise((resolve) => { resolveBootstrap = resolve; }),
    );

    const a = useAssetsStore.getState().initialize();
    const b = useAssetsStore.getState().initialize();
    expect(mocks.bootstrap).toHaveBeenCalledTimes(1);

    resolveBootstrap({ folders: [], sourceUrls: [] });
    await Promise.all([a, b]);

    expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
    expect(useAssetsStore.getState().initialized).toBe(true);
  });

  it("失败后在途标记清空，后续 initialize 可重试", async () => {
    mocks.bootstrap.mockRejectedValueOnce(new Error("network down"));

    await useAssetsStore.getState().initialize();
    expect(useAssetsStore.getState().initialized).toBe(false);

    mocks.bootstrap.mockResolvedValue({ folders: [], sourceUrls: [] });
    await useAssetsStore.getState().initialize();
    expect(useAssetsStore.getState().initialized).toBe(true);
    expect(mocks.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("已初始化后再次 initialize 不再发请求", async () => {
    mocks.bootstrap.mockResolvedValue({ folders: [], sourceUrls: [] });

    await useAssetsStore.getState().initialize();
    await useAssetsStore.getState().initialize();

    expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
  });
});

describe("资产文件夹选择", () => {
  it("使用最新文件夹数组计算当前目录的子文件夹", () => {
    const root = {
      id: "1", name: "Existing", scope: "personal" as const, kind: "normal" as const,
      parentId: undefined, createdAt: 0, count: 0,
    };
    const added = { ...root, id: "2", name: "Added" };
    const nested = { ...root, id: "3", name: "Nested", parentId: "1" };

    expect(selectChildFolders([root], "personal")).toEqual([root]);
    expect(selectChildFolders([root, added, nested], "personal")).toEqual([root, added]);
    expect(selectChildFolders([root, added, nested], "personal", "1")).toEqual([nested]);
  });
});
