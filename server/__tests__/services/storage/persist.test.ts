/**
 * 文件持久化的海报母版回归测试。
 * 锁定：视频落库时同步生成母版（specs/media-processing-concurrency.md 规则 8）；
 * 失败 / 媒体池过载不阻塞落盘；非视频文件不触发。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { ensureVideoMasterPoster, upsertFileObject } = vi.hoisted(() => ({
  ensureVideoMasterPoster: vi.fn(),
  upsertFileObject: vi.fn(),
}));

vi.mock("@server/services/storage/resize-cache", () => ({ ensureVideoMasterPoster }));
vi.mock("@server/crud/file", () => ({ upsertFileObject }));
vi.mock("@server/services/storage/media-probe", () => ({
  probePersistedMediaMeta: vi.fn(async () => ({ width: 1, height: 1, duration: 1 })),
}));
vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));

import { persistFileObject } from "@server/services/storage/persist";
import { MediaPoolBusyError } from "@server/services/storage/media-pool";
import { logEvent } from "@server/core/logger/utils";

describe("persistFileObject 海报母版", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("视频落库时同步等待母版生成完成（同一存储键）", async () => {
    upsertFileObject.mockResolvedValue(undefined);
    ensureVideoMasterPoster.mockResolvedValue(undefined);

    await persistFileObject({ userId: 3, hash: "ab12", size: 1, mimeType: "video/mp4", ext: ".mp4" });

    expect(ensureVideoMasterPoster).toHaveBeenCalledWith("3/ab/ab12.mp4");
  });

  it("母版生成失败不阻塞落盘，记日志后继续（档位首次请求时按需补生成）", async () => {
    upsertFileObject.mockResolvedValue(undefined);
    ensureVideoMasterPoster.mockRejectedValue(new Error("ffmpeg exploded"));

    const meta = await persistFileObject({ userId: 3, hash: "ab12", size: 1, mimeType: "video/mp4", ext: ".mp4" });

    expect(meta).toEqual({ width: 1, height: 1, duration: 1 });
    expect(upsertFileObject).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledWith("media", expect.objectContaining({
      stage: "poster_master_deferred",
      error: "ffmpeg exploded",
    }));
  });

  it("母版生成遇媒体池过载时同样记日志（带视频键上下文），不影响落盘", async () => {
    upsertFileObject.mockResolvedValue(undefined);
    ensureVideoMasterPoster.mockRejectedValue(new MediaPoolBusyError("ffmpeg_light", "global", "wait_timeout"));

    const meta = await persistFileObject({ userId: 3, hash: "ab12", size: 1, mimeType: "video/mp4", ext: ".mp4" });

    expect(meta).toEqual({ width: 1, height: 1, duration: 1 });
    expect(upsertFileObject).toHaveBeenCalledOnce();
    expect(logEvent).toHaveBeenCalledWith("media", expect.objectContaining({
      stage: "poster_master_deferred",
      video: "3/ab/ab12.mp4",
      error: expect.stringContaining("wait_timeout"),
    }));
  });

  it("非视频文件不生成母版", async () => {
    upsertFileObject.mockResolvedValue(undefined);

    await persistFileObject({ userId: 3, hash: "ab12", size: 1, mimeType: "image/png", ext: ".png" });

    expect(ensureVideoMasterPoster).not.toHaveBeenCalled();
  });
});
