/**
 * 上传格式白名单缓存的并发去重回归测试。
 *
 * 背景：AppProviders 启动预热 effect 在 React StrictMode 下双挂载，
 * 同步缓存守卫（if (cachedLimits) return）拦不住在途窗口，
 * /api/files/upload-limits 会真的发两次——在途 promise 去重后必须只发一次。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  api: (...args: unknown[]) => mocks.api(...args),
}));

const LIMITS = {
  maxSizeMb: 20,
  formats: { image: ["png"], video: ["mp4"], audio: ["mp3"] },
};

describe("upload-formats loadUploadLimits 并发去重", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.api.mockReset();
  });

  it("并发调用共享同一次请求", async () => {
    const { loadUploadLimits } = await import("@/lib/upload-formats");
    let resolveApi!: (v: unknown) => void;
    mocks.api.mockImplementation(
      () => new Promise((resolve) => { resolveApi = resolve; }),
    );

    const a = loadUploadLimits();
    const b = loadUploadLimits();
    expect(mocks.api).toHaveBeenCalledTimes(1);

    resolveApi(LIMITS);
    await Promise.all([a, b]);

    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  it("成功后走缓存，不再发请求", async () => {
    const { loadUploadLimits, getUploadFormats } = await import("@/lib/upload-formats");
    mocks.api.mockResolvedValue(LIMITS);

    await loadUploadLimits();
    await loadUploadLimits();

    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(getUploadFormats().image).toEqual(["png"]);
  });

  it("失败后在途标记清空，后续调用可重试", async () => {
    const { loadUploadLimits } = await import("@/lib/upload-formats");
    mocks.api.mockRejectedValueOnce(new Error("network down"));

    await expect(loadUploadLimits()).rejects.toThrow();
    mocks.api.mockResolvedValue(LIMITS);
    await expect(loadUploadLimits()).resolves.toEqual(LIMITS);

    expect(mocks.api).toHaveBeenCalledTimes(2);
  });
});
