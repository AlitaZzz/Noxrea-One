import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ffmpegDir = vi.hoisted(() => process.env.FFMPEG_TEST_DIR ?? process.env.FFMPEG_PATH ?? "ffmpeg");
const cfg = vi.hoisted(() => ({ uploadDir: "uploads" }));
vi.mock("@server/core/config", () => ({ getConfig: () => ({ FFMPEG_PATH: ffmpegDir, UPLOAD_DIR: cfg.uploadDir }) }));
vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));
vi.mock("@server/core/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());
import { runFfmpegLight, runFfprobe } from "@server/services/storage/ffmpeg";
import { probeImageMeta } from "@server/services/storage/media-probe";
import { captureVideoFrame } from "@server/services/storage/video-frames";
import { getVideoPosterWebP } from "@server/services/storage/resize-cache";
import { initStorageBackend } from "@server/services/storage/service";
import { LocalStorageBackend } from "@server/services/storage/backends/local";
import { logEvent } from "@server/core/logger/utils";

const bin = path.resolve(ffmpegDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const available = spawnSync(bin, ["-version"]).status === 0;
let temp = "";
describe.skipIf(!available)("real FFmpeg frame capture", () => {
  beforeAll(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "noxrea-frame-test-"));
    // 海报用例的后端与工作区根锚定隔离目录（uploadRoot 惰性读 config）
    cfg.uploadDir = temp;
    initStorageBackend(new LocalStorageBackend(temp));
  });
  afterAll(async () => { await fs.rm(temp, { recursive: true, force: true }); });

  it.each([1, 2, 10, 30])("captures the last actual frame at %s fps", async (fps) => {
    const source = path.join(temp, `source-${fps}.mkv`);
    const output = path.join(temp, `frame-${fps}.jpg`);
    execFileSync(bin, ["-v", "error", "-f", "lavfi", "-i", `testsrc2=s=128x72:r=${fps}:d=2`, "-c:v", "ffv1", "-y", source]);
    const time = await captureVideoFrame(source, output, { kind: "last" });
    // Matroska timestamps are quantized to milliseconds.
    expect(time).toBeCloseTo(Math.round((2 - 1 / fps) * 1000) / 1000, 4);
    expect(await probeImageMeta(output)).toEqual({ width: 128, height: 72 });
    const reference = path.join(temp, `reference-${fps}.jpg`);
    execFileSync(bin, ["-v", "error", "-i", source, "-vf", `select=eq(n\\,${2 * fps - 1})`, "-frames:v", "1", "-q:v", "2", "-y", reference]);
    expect(await fs.readFile(output)).toEqual(await fs.readFile(reference));
  });

  it("captures the last complete frame when the container's declared tail is truncated", async () => {
    const complete = path.join(temp, "complete.mkv");
    const source = path.join(temp, "truncated.mkv");
    const output = path.join(temp, "truncated.jpg");
    execFileSync(bin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=1:d=4", "-c:v", "ffv1", "-y", complete]);
    const probe = path.join(path.dirname(bin), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    const info = JSON.parse(execFileSync(probe, ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=pkt_pos", "-of", "json", complete], { encoding: "utf8" })) as { frames: { pkt_pos: string }[] };
    const contents = await fs.readFile(complete);
    await fs.writeFile(source, contents.subarray(0, Number(info.frames[2].pkt_pos)));
    expect(await captureVideoFrame(source, output, { kind: "last" })).toBe(1);
    expect(await probeImageMeta(output)).toEqual({ width: 128, height: 72 });
  });

  it("captures a variable-rate tail using its real timestamp", async () => {
    const source = path.join(temp, "variable.mkv");
    const output = path.join(temp, "variable.jpg");
    execFileSync(bin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=10:d=2", "-vf", "select='eq(n,0)+eq(n,3)+eq(n,12)'", "-fps_mode", "passthrough", "-c:v", "ffv1", "-y", source]);
    expect(await captureVideoFrame(source, output, { kind: "last" })).toBeCloseTo(1.2, 4);
    expect(await probeImageMeta(output)).toEqual({ width: 128, height: 72 });
  });

  it("captures a three-hour video tail whose full packet JSON exceeds the old index budget", async () => {
    const seed = path.join(temp, "long-seed.mp4");
    const source = path.join(temp, "three-hours.mp4");
    const output = path.join(temp, "three-hours.jpg");
    execFileSync(bin, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=32x32:r=30:d=1", "-c:v", "libx264", "-g", "30", "-y", seed]);
    execFileSync(bin, ["-v", "error", "-stream_loop", "-1", "-i", seed, "-t", "10800", "-c", "copy", "-y", source]);
    const probe = path.join(path.dirname(bin), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    const info = JSON.parse(execFileSync(probe, ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "json", source], { encoding: "utf8" })) as { streams: { nb_read_packets: string }[] };
    expect(Number(info.streams[0].nb_read_packets)).toBeGreaterThanOrEqual(324_000);
    await expect(runFfprobe(["-v", "error", "-select_streams", "v:0", "-of", "json", "-show_packets", "-show_entries", "packet=pts,flags", source], 30_000)).rejects.toThrow("metadata budget");
    // B-frame reordering can put presentation timestamps past the copy command's -t cutoff.
    const reference = JSON.parse(execFileSync(probe, ["-v", "error", "-select_streams", "v:0", "-read_intervals", "10799%", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time:format=start_time", "-of", "json", source], { encoding: "utf8" })) as { frames: { best_effort_timestamp_time: string }[]; format: { start_time: string } };
    const expectedTime = Number(reference.frames.at(-1)!.best_effort_timestamp_time) - Number(reference.format.start_time);
    expect(expectedTime).toBeGreaterThan(10799);
    expect(await captureVideoFrame(source, output, { kind: "last" })).toBeCloseTo(expectedTime, 5);
    expect(await probeImageMeta(output)).toEqual({ width: 32, height: 32 });
  }, 20_000);

  it("finds the preceding decoded frame when the last indexed key packet is corrupt", async () => {
    const source = path.join(temp, "corrupt-tail.mp4");
    const output = path.join(temp, "corrupt-tail.jpg");
    execFileSync(bin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=1:d=4", "-c:v", "libx264", "-g", "1", "-y", source]);
    const probe = path.join(path.dirname(bin), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    const info = JSON.parse(execFileSync(probe, ["-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pos,size", "-of", "json", source], { encoding: "utf8" })) as { packets: { pos: string; size: string }[] };
    const packet = info.packets.at(-1)!;
    const contents = await fs.readFile(source);
    contents.fill(0, Number(packet.pos), Number(packet.pos) + Number(packet.size));
    await fs.writeFile(source, contents);
    expect(await captureVideoFrame(source, output, { kind: "last" })).toBe(2);
    expect(await probeImageMeta(output)).toEqual({ width: 128, height: 72 });
  });

  it("preserves a delayed video stream's timestamp relative to the audio timeline", async () => {
    const source = path.join(temp, "delayed-video.mkv");
    const output = path.join(temp, "delayed-video.jpg");
    execFileSync(bin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=1:d=2", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-vf", "setpts=PTS+2/TB", "-fps_mode", "passthrough", "-t", "4", "-c:v", "ffv1", "-c:a", "pcm_s16le", "-y", source]);
    expect(await captureVideoFrame(source, output, { kind: "last" })).toBe(3);
    expect(await probeImageMeta(output)).toEqual({ width: 128, height: 72 });
  });

  it("returns playback time for a container with a nonzero starting timestamp", async () => {
    const source = path.join(temp, "offset-start.mkv");
    const output = path.join(temp, "offset-start.jpg");
    execFileSync(bin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=1:d=2", "-c:v", "ffv1", "-output_ts_offset", "10", "-y", source]);
    expect(await captureVideoFrame(source, output, { kind: "last" })).toBe(1);
  });

  it("rejects an already-aborted tail request without producing an image", async () => {
    const output = path.join(temp, "cancelled.jpg");
    const controller = new AbortController();
    controller.abort();
    await expect(captureVideoFrame(path.join(temp, "unused.mkv"), output, { kind: "last" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(fs.access(output)).rejects.toThrow();
  });

  it("closes a real running FFmpeg process on cancellation", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(runFfmpegLight(["-re", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=1", "-f", "null", "-"], 5000, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(timer);
    }
  });

  it("closes a real running FFmpeg process on timeout", async () => {
    await expect(runFfmpegLight(["-re", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=1", "-f", "null", "-"], 100)).rejects.toThrow("timed out");
  });

  it("海报母版每视频只解码一次，档位由 sharp 从母版派生", async () => {
    await fs.mkdir(path.join(temp, "u1/ab"), { recursive: true });
    const source = path.join(temp, "u1/ab/poster.mkv");
    execFileSync(bin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:d=0.5", "-c:v", "ffv1", "-y", source]);

    await getVideoPosterWebP("u1/ab/poster.mkv", 64);
    await getVideoPosterWebP("u1/ab/poster.mkv", 480);

    const masterRuns = vi.mocked(logEvent).mock.calls.filter(([, fields]) => (fields as { stage?: string }).stage === "poster_master").length;
    expect(masterRuns).toBe(1);
    // 母版 min(源宽, 3840) = 320；两个档位各自落盘（480 档不放大，实际 320 宽）
    await expect(fs.stat(path.join(temp, "_posters/v1/u1/ab/poster.webp"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(temp, "_cache/64/u1/ab/poster.webp"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(temp, "_cache/480/u1/ab/poster.webp"))).resolves.toBeTruthy();
  });

  it("并发请求全部档位只解码一次，再次请求全部命中缓存", async () => {
    await fs.mkdir(path.join(temp, "u1/ab"), { recursive: true });
    const source = path.join(temp, "u1/ab/tiers.mkv");
    execFileSync(bin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:d=0.5", "-c:v", "ffv1", "-y", source]);

    const widths = [64, 112, 200, 300, 320, 400, 480, 1280] as const;
    const keys = await Promise.all(widths.map((w) => getVideoPosterWebP("u1/ab/tiers.mkv", w)));
    expect(keys.every((key) => key !== null)).toBe(true);
    // 日志按视频名过滤：同文件其他用例的 poster_master 不计入
    const masterRuns = () => vi.mocked(logEvent).mock.calls.filter(([, fields]) => {
      const f = fields as { stage?: string; video?: string };
      return f.stage === "poster_master" && f.video === "tiers.mkv";
    }).length;
    expect(masterRuns()).toBe(1);
    for (const width of widths) {
      await expect(fs.stat(path.join(temp, `_cache/${width}/u1/ab/tiers.webp`))).resolves.toBeTruthy();
    }

    // 再次并发请求全部命中缓存：母版不重新解码
    await Promise.all(widths.map((w) => getVideoPosterWebP("u1/ab/tiers.mkv", w)));
    expect(masterRuns()).toBe(1);
  });
});
