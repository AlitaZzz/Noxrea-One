/**
 * 视频完整性体检：全量解码占 ffmpeg 重型池（按属主取个人名额），过载拒绝不得被
 * 当作「无法判定」写入缓存（specs/media-processing-concurrency.md 业务规则 4）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ probeFfmpeg: vi.fn(), probeFfmpegDecode: vi.fn() }));
vi.mock("@server/services/storage/ffmpeg", () => ({
  probeFfmpeg: mocks.probeFfmpeg,
  probeFfmpegDecode: mocks.probeFfmpegDecode,
}));
vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());
vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));

import {
  peekVideoIntegrityCached,
  peekVideoMetaCached,
  probeVideoIntegrity,
  probeVideoMetaCached,
} from "@server/services/storage/media-probe";
import { MediaPoolBusyError } from "@server/services/storage/media-pool";

beforeEach(() => vi.clearAllMocks());

describe("probeVideoIntegrity", () => {
  it("经全量解码入口探测（按属主占 ffmpeg 重型池），不走仅读头部的轻量探测", async () => {
    mocks.probeFfmpegDecode.mockResolvedValue({ stderr: "time=00:00:10.00", killed: false, spawnFailed: false });
    await probeVideoIntegrity("decode-entry.mp4", 10, { owner: 5, cacheKey: "decode-entry.mp4" });
    expect(mocks.probeFfmpegDecode).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Number),
      expect.objectContaining({ stage: "video_integrity", owner: 5 }),
    );
    expect(mocks.probeFfmpeg).not.toHaveBeenCalled();
  });

  it("池过载向上抛出，且不写入缓存：之后可重新探测并得到真实结果", async () => {
    mocks.probeFfmpegDecode.mockRejectedValueOnce(new MediaPoolBusyError("ffmpeg_heavy", "global", "queue_full"));
    await expect(probeVideoIntegrity("overload.mp4", 60, { owner: 1, cacheKey: "overload.mp4" })).rejects.toBeInstanceOf(MediaPoolBusyError);

    mocks.probeFfmpegDecode.mockResolvedValueOnce({ stderr: "time=00:00:20.00", killed: false, spawnFailed: false });
    await expect(probeVideoIntegrity("overload.mp4", 60, { owner: 1, cacheKey: "overload.mp4" })).resolves.toEqual({
      decodableDuration: 20,
      truncated: true,
    });
    expect(mocks.probeFfmpegDecode).toHaveBeenCalledTimes(2);
  });

  it("同一内容键下不同租约路径共享完整性结论", async () => {
    mocks.probeFfmpegDecode.mockResolvedValue({ stderr: "time=00:00:10.00", killed: false, spawnFailed: false });
    await probeVideoIntegrity("/work/_tmp/a.mp4", 10, { owner: 1, cacheKey: "3/ab/content.mp4" });
    await probeVideoIntegrity("/work/_tmp/b.mp4", 10, { owner: 1, cacheKey: "3/ab/content.mp4" });
    expect(mocks.probeFfmpegDecode).toHaveBeenCalledTimes(1);
    expect(peekVideoIntegrityCached("3/ab/content.mp4", 10)).toEqual({
      decodableDuration: 10,
      truncated: false,
    });
  });

  it("探测成功后结果被缓存，不重复解码", async () => {
    mocks.probeFfmpegDecode.mockResolvedValue({ stderr: "time=00:01:00.00", killed: false, spawnFailed: false });
    await probeVideoIntegrity("cached.mp4", 60, { owner: 1, cacheKey: "cached.mp4" });
    await probeVideoIntegrity("cached.mp4", 60, { owner: 1, cacheKey: "cached.mp4" });
    expect(mocks.probeFfmpegDecode).toHaveBeenCalledTimes(1);
  });

  it("同一视频的并发首次问询共用一次全量解码", async () => {
    let finish!: (outcome: { stderr: string; killed: boolean; spawnFailed: boolean }) => void;
    mocks.probeFfmpegDecode.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

    const first = probeVideoIntegrity("concurrent.mp4", 60, { owner: 1, cacheKey: "concurrent.mp4" });
    const second = probeVideoIntegrity("concurrent.mp4", 60, { owner: 1, cacheKey: "concurrent.mp4" });
    await vi.waitFor(() => expect(mocks.probeFfmpegDecode).toHaveBeenCalledTimes(1));
    finish({ stderr: "time=00:01:00.00", killed: false, spawnFailed: false });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { decodableDuration: 60, truncated: false },
      { decodableDuration: 60, truncated: false },
    ]);
    expect(mocks.probeFfmpegDecode).toHaveBeenCalledTimes(1);
  });

  it("不同超时预算互不复用在途解码", async () => {
    mocks.probeFfmpegDecode.mockResolvedValue({ stderr: "time=00:00:30.00", killed: false, spawnFailed: false });
    await Promise.all([
      probeVideoIntegrity("budget.mp4", 30, { timeoutMs: 1_500, owner: 1, cacheKey: "budget.mp4" }),
      probeVideoIntegrity("budget.mp4", 30, { owner: 1, cacheKey: "budget.mp4" }),
    ]);
    expect(mocks.probeFfmpegDecode).toHaveBeenCalledTimes(2);
  });

  it("全部问询方断开后取消解码；信号传给 ffmpeg 探测", async () => {
    let genSignal: AbortSignal | undefined;
    mocks.probeFfmpegDecode.mockImplementation((_args: string[], _timeout: number, opts: { signal: AbortSignal }) => {
      genSignal = opts.signal;
      return new Promise((_, reject) => {
        opts.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const controller = new AbortController();

    const pending = probeVideoIntegrity("abort.mp4", 60, { signal: controller.signal, owner: 1, cacheKey: "abort.mp4" });
    await vi.waitFor(() => expect(genSignal).toBeDefined());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(genSignal?.aborted).toBe(true);
  });
});

describe("probeVideoMetaCached 稳定内容键与负缓存", () => {
  const VIDEO_STDERR =
    "Duration: 00:00:10.00, start: 0.000000, bitrate: 1 kb/s\n" +
    "Stream #0:0: Video: h264, yuv420p, 640x360, 30 fps, 30 tbr";

  it("同一内容键下不同租约路径只探测一次", async () => {
    mocks.probeFfmpeg.mockResolvedValue({ stderr: VIDEO_STDERR, killed: false, spawnFailed: false });

    const first = await probeVideoMetaCached("/work/_tmp/a.mp4", "3/ab/meta-content.mp4");
    const second = await probeVideoMetaCached("/work/_tmp/b.mp4", "3/ab/meta-content.mp4");

    expect(first).toEqual({ fps: 30, width: 640, height: 360, duration: 10 });
    expect(second).toEqual(first);
    expect(mocks.probeFfmpeg).toHaveBeenCalledTimes(1);
  });

  it("负结果只在 TTL 内复用，过期后重新探测", async () => {
    vi.useFakeTimers();
    try {
      mocks.probeFfmpeg.mockResolvedValue({ stderr: "", killed: false, spawnFailed: false });
      await probeVideoMetaCached("/work/_tmp/a.mp4", "3/ab/negative.mp4");
      await probeVideoMetaCached("/work/_tmp/b.mp4", "3/ab/negative.mp4");
      expect(mocks.probeFfmpeg).toHaveBeenCalledTimes(1);
      expect(peekVideoMetaCached("3/ab/negative.mp4")).toBeNull();

      vi.advanceTimersByTime(60_001);
      mocks.probeFfmpeg.mockResolvedValue({ stderr: VIDEO_STDERR, killed: false, spawnFailed: false });
      const meta = await probeVideoMetaCached("/work/_tmp/c.mp4", "3/ab/negative.mp4");

      expect(meta?.duration).toBe(10);
      expect(mocks.probeFfmpeg).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
