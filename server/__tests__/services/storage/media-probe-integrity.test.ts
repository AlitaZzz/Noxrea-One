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

import { probeVideoIntegrity } from "@server/services/storage/media-probe";
import { MediaPoolBusyError } from "@server/services/storage/media-pool";

beforeEach(() => vi.clearAllMocks());

describe("probeVideoIntegrity", () => {
  it("经全量解码入口探测（按属主占 ffmpeg 重型池），不走仅读头部的轻量探测", async () => {
    mocks.probeFfmpegDecode.mockResolvedValue({ stderr: "time=00:00:10.00", killed: false, spawnFailed: false });
    await probeVideoIntegrity("decode-entry.mp4", 10, { owner: 5 });
    expect(mocks.probeFfmpegDecode).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Number),
      expect.objectContaining({ stage: "video_integrity", owner: 5 }),
    );
    expect(mocks.probeFfmpeg).not.toHaveBeenCalled();
  });

  it("池过载向上抛出，且不写入缓存：之后可重新探测并得到真实结果", async () => {
    mocks.probeFfmpegDecode.mockRejectedValueOnce(new MediaPoolBusyError("ffmpeg_heavy", "global", "queue_full"));
    await expect(probeVideoIntegrity("overload.mp4", 60, { owner: 1 })).rejects.toBeInstanceOf(MediaPoolBusyError);

    mocks.probeFfmpegDecode.mockResolvedValueOnce({ stderr: "time=00:00:20.00", killed: false, spawnFailed: false });
    await expect(probeVideoIntegrity("overload.mp4", 60, { owner: 1 })).resolves.toEqual({
      decodableDuration: 20,
      truncated: true,
    });
    expect(mocks.probeFfmpegDecode).toHaveBeenCalledTimes(2);
  });

  it("探测成功后结果被缓存，不重复解码", async () => {
    mocks.probeFfmpegDecode.mockResolvedValue({ stderr: "time=00:01:00.00", killed: false, spawnFailed: false });
    await probeVideoIntegrity("cached.mp4", 60, { owner: 1 });
    await probeVideoIntegrity("cached.mp4", 60, { owner: 1 });
    expect(mocks.probeFfmpegDecode).toHaveBeenCalledTimes(1);
  });

  it("同一视频的并发首次问询共用一次全量解码", async () => {
    let finish!: (outcome: { stderr: string; killed: boolean; spawnFailed: boolean }) => void;
    mocks.probeFfmpegDecode.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

    const first = probeVideoIntegrity("concurrent.mp4", 60, { owner: 1 });
    const second = probeVideoIntegrity("concurrent.mp4", 60, { owner: 1 });
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
      probeVideoIntegrity("budget.mp4", 30, { timeoutMs: 1_500, owner: 1 }),
      probeVideoIntegrity("budget.mp4", 30, { owner: 1 }),
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

    const pending = probeVideoIntegrity("abort.mp4", 60, { signal: controller.signal, owner: 1 });
    await vi.waitFor(() => expect(genSignal).toBeDefined());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(genSignal?.aborted).toBe(true);
  });
});
