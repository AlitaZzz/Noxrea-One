/**
 * 文件持久化的海报预热回归测试。
 * 锁定：视频落库后以 480px 触发 getVideoPosterWebP 预热；非视频文件不触发。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { getVideoPosterWebP, upsertFileObject } = vi.hoisted(() => ({
  getVideoPosterWebP: vi.fn(),
  upsertFileObject: vi.fn(),
}));

vi.mock("@server/services/storage/resize-cache", () => ({ getVideoPosterWebP }));
vi.mock("@server/crud/file", () => ({ upsertFileObject }));
vi.mock("@server/services/storage/media-probe", () => ({
  probePersistedMediaMeta: vi.fn(async () => ({ width: 1, height: 1, duration: 1 })),
}));
vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));

import { persistFileObject } from "@server/services/storage/persist";

describe("persistFileObject 海报预热", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("视频落库后以 480px 预热海报（fire-and-forget，与探针共用同一存储键）", async () => {
    upsertFileObject.mockResolvedValue(undefined);
    getVideoPosterWebP.mockResolvedValue("_cache/480/x.webp");

    await persistFileObject({ userId: 3, hash: "ab12", size: 1, mimeType: "video/mp4", ext: ".mp4" });

    expect(getVideoPosterWebP).toHaveBeenCalledWith("3/ab/ab12.mp4", 480);
  });

  it("预热失败不影响落盘结果", async () => {
    upsertFileObject.mockResolvedValue(undefined);
    getVideoPosterWebP.mockRejectedValue(new Error("ffmpeg exploded"));

    const meta = await persistFileObject({ userId: 3, hash: "ab12", size: 1, mimeType: "video/mp4", ext: ".mp4" });

    expect(meta).toEqual({ width: 1, height: 1, duration: 1 });
    expect(upsertFileObject).toHaveBeenCalledOnce();
  });

  it("非视频文件不触发预热", async () => {
    upsertFileObject.mockResolvedValue(undefined);

    await persistFileObject({ userId: 3, hash: "ab12", size: 1, mimeType: "image/png", ext: ".png" });

    expect(getVideoPosterWebP).not.toHaveBeenCalled();
  });
});
