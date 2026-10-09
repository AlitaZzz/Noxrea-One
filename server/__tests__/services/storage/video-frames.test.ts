import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ffmpegDir = vi.hoisted(() => process.env.FFMPEG_TEST_DIR ?? process.env.FFMPEG_PATH ?? "ffmpeg");
vi.mock("@server/core/config", () => ({ getConfig: () => ({ FFMPEG_PATH: ffmpegDir, UPLOAD_DIR: "uploads" }) }));
vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));
import { runFfmpeg, runFfprobe } from "@server/services/storage/ffmpeg";
import { probeImageMeta } from "@server/services/storage/media-probe";
import { captureVideoFrame } from "@server/services/storage/video-frames";

const bin = path.resolve(ffmpegDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const available = spawnSync(bin, ["-version"]).status === 0;
let temp = "";
describe.skipIf(!available)("real FFmpeg frame capture", () => {
  beforeAll(async () => { temp = await fs.mkdtemp(path.join(os.tmpdir(), "noxrea-frame-test-")); });
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
      await expect(runFfmpeg(["-re", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=1", "-f", "null", "-"], 5000, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(timer);
    }
  });

  it("closes a real running FFmpeg process on timeout", async () => {
    await expect(runFfmpeg(["-re", "-f", "lavfi", "-i", "testsrc2=s=128x72:r=1", "-f", "null", "-"], 100)).rejects.toThrow("timed out");
  });
});
