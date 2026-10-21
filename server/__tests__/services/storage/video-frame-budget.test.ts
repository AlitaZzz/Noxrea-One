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
    await expect(captureVideoFrame("broken.mp4", "frame.jpg", { kind: "last" })).rejects.toThrow("timed out");
    expect(elapsed).toBeLessThanOrEqual(90_000);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("passes only the remaining operation budget to final image capture", async () => {
    mocks.scan.mockImplementation(async (_args: string[], _timeout: number, opts: { section: string; onEntry: (value: unknown) => void }) => {
      if (opts.section === "packets") packets.forEach(opts.onEntry);
      else { elapsed = 85_000; opts.onEntry({ best_effort_timestamp: 9000 }); return { entryCount: 1, stderr: "" }; }
    });
    mocks.probe.mockResolvedValue(metadata);
    await captureVideoFrame("slow.mp4", "frame.jpg", { kind: "last" });
    expect(mocks.capture.mock.calls[0][1]).toBeLessThanOrEqual(5000);
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

    await expect(captureVideoFrame("corrupt-tail.mp4", "frame.jpg", { kind: "last" })).resolves.toBe(8);
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

    await expect(captureVideoFrame("flaky-tail.mp4", "frame.jpg", { kind: "last" })).resolves.toBe(3);
    expect(tailScans).toBe(2);
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

    await expect(captureVideoFrame("corrupt.mp4", "frame.jpg", { kind: "last" })).resolves.toBe(2);
    expect(tailScans).toBe(2);
  });
});
