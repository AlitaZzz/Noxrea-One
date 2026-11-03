import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ probe: vi.fn(), scan: vi.fn(), capture: vi.fn() }));
vi.mock("@server/services/storage/ffmpeg", () => ({
  runFfprobe: mocks.probe,
  scanFfprobe: mocks.scan,
  runFfmpegLight: mocks.capture,
  runFfmpegHeavy: vi.fn(),
}));
vi.mock("fs/promises", () => ({ default: { mkdir: vi.fn() } }));
vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));
import { logEvent } from "@server/core/logger/utils";
import { captureVideoFrame } from "@server/services/storage/video-frames";

const metadata = { streams: [{ time_base: "1/1000" }], format: { start_time: 0 } };
const packets = Array.from({ length: 10 }, (_, pts) => ({ pts: pts * 1000, flags: "K_" }));
let elapsed: number;
beforeEach(() => {
  vi.resetAllMocks();
  elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  mocks.probe.mockImplementation(async () => {
    elapsed += 10_000;
    return metadata;
  });
  mocks.scan.mockImplementation(async (_args: string[], timeout: number, opts: { section: string; onEntry: (value: unknown) => void }) => {
    if (opts.section === "packets") {
      elapsed += 10_000;
      packets.forEach(opts.onEntry);
    } else {
      const step = Math.min(20_000, timeout);
      elapsed += step;
      if (step < 20_000) throw new Error("ffprobe timed out");
      return { entryCount: 0, stderr: "" };
    }
  });
  mocks.capture.mockResolvedValue({ code: 0, stderr: "" });
});
afterEach(() => vi.restoreAllMocks());

describe("frame capture operation budget", () => {
  it("bounds the combined metadata, packet scan and corrupt-keyframe traversal", async () => {
    await expect(captureVideoFrame("broken.mp4", "frame.jpg", { kind: "last" }, "broken.mp4")).rejects.toThrow("timed out");
    expect(elapsed).toBeLessThanOrEqual(90_000);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("passes only the remaining operation budget to final image capture", async () => {
    mocks.scan.mockImplementation(async (_args: string[], _timeout: number, opts: { section: string; onEntry: (value: unknown) => void }) => {
      if (opts.section === "packets") packets.forEach(opts.onEntry);
      else { elapsed = 85_000; opts.onEntry({ best_effort_timestamp: 9000 }); return { entryCount: 1, stderr: "" }; }
    });
    mocks.probe.mockResolvedValue(metadata);
    await captureVideoFrame("slow.mp4", "frame.jpg", { kind: "last" }, "slow.mp4");
    expect(mocks.capture.mock.calls[0][1]).toBeLessThanOrEqual(5000);
  });

  it("uses the declared video stream duration to resolve the last frame without indexing packets", async () => {
    mocks.probe.mockResolvedValue({
      streams: [{ time_base: "1/1000", start_time: 0, duration: 2 }],
      format: { start_time: 0 },
    });
    mocks.scan.mockImplementation(async (args: string[], _timeout: number, opts: { section: string; onEntry: (value: unknown) => void }) => {
      expect(opts.section).toBe("frames");
      expect(args[args.indexOf("-read_intervals") + 1]).toBe("0%");
      opts.onEntry({ best_effort_timestamp: 1900 });
      return { entryCount: 1, stderr: "" };
    });

    // 请求越过视频流末帧（容器时间轴可以更长）时收敛到末帧并按 PTS 精确选择
    await expect(captureVideoFrame("fast-tail.mp4", "frame.jpg", { kind: "time", seconds: 5 }, "fast-tail.mp4")).resolves.toBeCloseTo(1.9, 10);
    expect(mocks.scan).toHaveBeenCalledOnce();
    expect(mocks.capture.mock.calls[0][0]).toContain("-copyts");
    expect(mocks.capture.mock.calls[0][0]).toContain("select=eq(pts\\,1900)");

    // 末帧已缓存：同一源的后续截取不再探测；未越界的请求仍走普通 seek
    await expect(captureVideoFrame("fast-tail.mp4", "frame-before.jpg", { kind: "time", seconds: 1 }, "fast-tail.mp4")).resolves.toBe(1);
    expect(mocks.scan).toHaveBeenCalledOnce();
    expect(mocks.capture.mock.calls[1][0]).not.toContain("-copyts");
  });

  it("skips a tail frame without a timestamp and falls back to the preceding GOP", async () => {
    let frameScanCount = 0;
    mocks.scan.mockImplementation(async (_args: string[], _timeout: number, opts: { section: string; onEntry: (value: unknown) => void }) => {
      if (opts.section === "packets") {
        packets.slice(-2).forEach(opts.onEntry);
        return { entryCount: 2, stderr: "" };
      }
      // 首扫交付了无时间戳条目（entryCount=1）：非「干净空结果」，不触发重试，
      // 直接回退前一个 GOP —— 保护既有回退语义不被重试机制改变
      if (frameScanCount++ === 0) { opts.onEntry({}); return { entryCount: 1, stderr: "" }; }
      opts.onEntry({ best_effort_timestamp: 8000 });
      return { entryCount: 1, stderr: "" };
    });

    await expect(captureVideoFrame("corrupt-tail.mp4", "frame.jpg", { kind: "last" }, "corrupt-tail.mp4")).resolves.toBe(8);
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.capture.mock.calls[0][0]).toContain("select=eq(pts\\,8000)");
  });

  it("尾帧扫描出现干净空结果（exit 0 零条目无 stderr）时重试一次并正常取帧", async () => {
    let tailScans = 0;
    mocks.scan.mockImplementation(async (_args: string[], _timeout: number, opts: { section: string; onEntry: (value: unknown) => void }) => {
      if (opts.section === "packets") { packets.slice(-1).forEach(opts.onEntry); return { entryCount: 1, stderr: "" }; }
      tailScans += 1;
      if (tailScans === 1) return { entryCount: 0, stderr: "" };
      opts.onEntry({ best_effort_timestamp: 3000 });
      return { entryCount: 1, stderr: "" };
    });
    mocks.probe.mockResolvedValue(metadata);

    await expect(captureVideoFrame("flaky-tail.mp4", "frame.jpg", { kind: "last" }, "flaky-tail.mp4")).resolves.toBe(3);
    expect(tailScans).toBe(2);
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("锚点快路径的干净空结果不重试：直接退回包索引，避免对合法空窗口重复解码", async () => {
    let tailScans = 0;
    mocks.probe.mockResolvedValue({
      streams: [{ time_base: "1/1000", start_time: 0, duration: 2 }],
      format: { start_time: 0 },
    });
    mocks.scan.mockImplementation(async (args: string[], _timeout: number, opts: { section: string; onEntry: (value: unknown) => void }) => {
      if (opts.section === "packets") { packets.slice(-1).forEach(opts.onEntry); return { entryCount: 1, stderr: "" }; }
      tailScans += 1;
      // 锚点窗口读到 EOF 为空是合法内容（容器时长可能落在视频末帧之后）：
      // 这里连续两次空扫描分别代表「原始锚点扫描」与旧实现才会发生的「空结果重试」
      if (args[args.indexOf("-read_intervals") + 1] === "0%") return { entryCount: 0, stderr: "" };
      opts.onEntry({ best_effort_timestamp: 3000 });
      return { entryCount: 1, stderr: "" };
    });

    await expect(captureVideoFrame("audio-tail.mp4", "frame.jpg", { kind: "last" }, "audio-tail.mp4")).resolves.toBe(3);
    // 锚点扫描 1 次 + 包索引证实的末关键帧 GOP 扫描 1 次；没有额外的锚点重试
    expect(tailScans).toBe(2);
    expect(vi.mocked(logEvent).mock.calls.map(([, fields]) => (fields as { stage?: string }).stage))
      .not.toContain("capture_tail_empty_retry");
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("损坏尾巴（空扫描但 stderr 非空）不触发重试，直接回退前一个 GOP", async () => {
    let tailScans = 0;
    mocks.scan.mockImplementation(async (_args: string[], _timeout: number, opts: { section: string; onEntry: (value: unknown) => void }) => {
      if (opts.section === "packets") { packets.slice(-2).forEach(opts.onEntry); return { entryCount: 2, stderr: "" }; }
      tailScans += 1;
      if (tailScans === 1) return { entryCount: 0, stderr: "Invalid NAL unit size" };
      opts.onEntry({ best_effort_timestamp: 2000 });
      return { entryCount: 1, stderr: "" };
    });
    mocks.probe.mockResolvedValue(metadata);

    await expect(captureVideoFrame("corrupt.mp4", "frame.jpg", { kind: "last" }, "corrupt.mp4")).resolves.toBe(2);
    expect(tailScans).toBe(2);
  });
});
