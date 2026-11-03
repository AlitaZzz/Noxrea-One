/**
 * 截帧末帧探测的降级语义（单测，经 ./ffmpeg 跨模块缝打桩）：
 * - 普通时间截取：末帧定位失败只失去「越过末帧时收敛」的保护，按请求时间直接 seek；
 * - 显式末帧：定位失败没有可降级的语义，原样上抛；
 * - 取消与截帧预算耗尽：属于调用方语义，不得被降级吞掉；
 * - 单次探测调用自身的超时：余量尚在，按探测失败降级。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ffmpegMocks = vi.hoisted(() => ({
  runFfmpegLight: vi.fn(),
  runFfmpegHeavy: vi.fn(),
  runFfprobe: vi.fn(),
  scanFfprobe: vi.fn(),
}));

vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));
vi.mock("@server/services/storage/ffmpeg", () => ffmpegMocks);

import { TimeoutError } from "@server/core/abort";
import { logEvent } from "@server/core/logger/utils";
import { captureVideoFrame } from "@server/services/storage/video-frames";

/** 可解析的时间线：视频流 2s、容器 2s */
const TIMELINE = {
  streams: [{ time_base: "1/1000", start_time: "0.000000", duration: "2.000000" }],
  format: { start_time: 0, duration: 2 },
};

function loggedStages(): string[] {
  return vi.mocked(logEvent).mock.calls
    .filter(([scope]) => scope === "media")
    .map(([, fields]) => (fields as { stage?: string }).stage ?? "");
}

describe("captureVideoFrame 末帧探测降级", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ffmpegMocks.runFfmpegLight.mockResolvedValue({ code: 0, stderr: "" });
    ffmpegMocks.runFfprobe.mockResolvedValue(TIMELINE);
  });

  it("普通时间点：尾段扫描失败时按请求时间直接 seek，不输出 -copyts/select", async () => {
    ffmpegMocks.scanFfprobe.mockRejectedValue(new Error("ffprobe exited with code 1: corrupt tail"));

    await expect(
      captureVideoFrame("source.mp4", "out.jpg", { kind: "time", seconds: 3.5 }, "time-degrade"),
    ).resolves.toBe(3.5);

    const args = ffmpegMocks.runFfmpegLight.mock.calls[0][0] as string[];
    expect(args).not.toContain("-copyts");
    expect(args[args.indexOf("-ss") + 1]).toBe("3.5");
    expect(loggedStages()).toContain("capture_end_probe_failed");
    expect(loggedStages()).not.toContain("capture_frame_clamped");
  });

  it("显式末帧：定位失败没有降级语义，原样上抛", async () => {
    ffmpegMocks.scanFfprobe.mockRejectedValue(new Error("ffprobe exited with code 1: corrupt tail"));

    await expect(
      captureVideoFrame("source.mp4", "out.jpg", { kind: "last" }, "last-failure"),
    ).rejects.toThrow("corrupt tail");
    expect(ffmpegMocks.runFfmpegLight).not.toHaveBeenCalled();
  });

  it("显式末帧：扫描非 0 退出且没有条目时保留 ffprobe 诊断", async () => {
    ffmpegMocks.scanFfprobe.mockResolvedValue({ entryCount: 0, stderr: "Invalid data found", code: 1 });

    await expect(
      captureVideoFrame("source.mp4", "out.jpg", { kind: "last" }, "last-zero-scan"),
    ).rejects.toThrow("ffprobe exited with code 1: Invalid data found");
    expect(ffmpegMocks.runFfmpegLight).not.toHaveBeenCalled();
  });

  it("取消不得被降级吞掉", async () => {
    const error = Object.assign(new Error("aborted"), { name: "AbortError" });
    ffmpegMocks.scanFfprobe.mockRejectedValue(error);

    await expect(
      captureVideoFrame("source.mp4", "out.jpg", { kind: "time", seconds: 1 }, "propagate-cancel"),
    ).rejects.toBe(error);
    expect(ffmpegMocks.runFfmpegLight).not.toHaveBeenCalled();
  });

  it("单次探测超时且预算尚在：按探测失败降级，不把普通时间点变成 500", async () => {
    ffmpegMocks.scanFfprobe.mockRejectedValue(new TimeoutError("ffprobe timed out after 30000ms"));

    await expect(
      captureVideoFrame("source.mp4", "out.jpg", { kind: "time", seconds: 1 }, "probe-timeout-degrade"),
    ).resolves.toBe(1);
    expect(loggedStages()).toContain("capture_end_probe_failed");
    expect(ffmpegMocks.runFfmpegLight).toHaveBeenCalledTimes(1);
  });

  it("截帧预算耗尽不得被降级吞掉", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      // 探测失败时预算已耗尽：此时没有余量做普通 seek，必须上抛映射 504
      ffmpegMocks.scanFfprobe.mockImplementation(async () => {
        now = 90_001;
        throw new Error("corrupt tail");
      });

      await expect(
        captureVideoFrame("source.mp4", "out.jpg", { kind: "time", seconds: 1 }, "propagate-budget"),
      ).rejects.toThrow("Video frame capture timed out");
      expect(loggedStages()).not.toContain("capture_end_probe_failed");
      expect(ffmpegMocks.runFfmpegLight).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});
