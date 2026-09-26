/**
 * 音视频剪辑操作：音轨分离、静音视频、片段截取、变速与画面裁剪。
 * 全部走 ffmpeg 统一执行器；产物先写临时文件，落盘去重由调用方（路由）负责。
 */

import path from "path";
import fs from "fs/promises";
import { logEvent } from "@server/core/logger/utils";
import { runFfmpeg } from "./ffmpeg";

/** 音视频分离超时：即便 copy 也要完整读一遍长视频，抽帧的 30s 兜不住 */
const FFMPEG_AUDIO_TIMEOUT_MS = 120_000;

/** 片段截取/裁剪的重编码超时：8 分钟全片 veryfast 720p 约需 1 分钟，留出约 2.7 倍最坏情形余量 */
const FFMPEG_CLIP_TIMEOUT_MS = 300_000;

/**
 * 音轨输出格式。
 * copy = 原编码原样封装进 MP4 容器（不解码，比特级无损）；
 * wav  = 源编码装不进 MP4 容器时的回退路径（PCM 重编码，仍无损，但体积大）。
 */
const AUDIO_OUTPUT_FORMATS = {
  copy: { ext: ".m4a", mime: "audio/mp4" },
  wav: { ext: ".wav", mime: "audio/wav" },
} as const;

/** 无音轨：源视频不含任何音频流。调用方据此给出明确提示，而非笼统的「处理失败」 */
export class NoAudioTrackError extends Error {
  constructor(message = "Source video contains no audio stream") {
    super(message);
    this.name = "NoAudioTrackError";
  }
}

export type AudioExtractFormat = keyof typeof AUDIO_OUTPUT_FORMATS;

export interface ExtractedAudio {
  /** 产物临时路径（扩展名随最终采用的格式而变） */
  path: string;
  format: AudioExtractFormat;
  ext: string;
  mime: string;
}

/** ffmpeg stderr 中「指定流不存在」的标志性输出 */
function isMissingStream(stderr: string): boolean {
  return (
    stderr.includes("matches no streams") ||
    stderr.includes("does not contain any stream")
  );
}

/** 非零退出 + stderr 末段 → 统一错误（stderr 全量已由执行器日志持有） */
function exitError(code: number, stderr: string): Error {
  return new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200)}`);
}

/**
 * 从视频中分离音轨（无损优先）。
 *
 * 阶段一 `-acodec copy`：只换容器不解码。绝大多数视频音轨是 AAC，
 * 可直接封装进 MP4 容器，比特级无损且耗时近乎为零。
 * 阶段二（回退）：源编码装不进 MP4 容器时（Opus / Vorbis / PCM）重编码为 PCM wav。
 *
 * 源视频不含音频流时抛 NoAudioTrackError。
 */
export async function extractAudioTrack(
  videoPath: string,
  outputDir: string,
  baseName: string,
  signal?: AbortSignal,
): Promise<ExtractedAudio> {
  await fs.mkdir(outputDir, { recursive: true });

  const logFields = { video: path.basename(videoPath) };
  const copyPath = path.join(outputDir, `${baseName}${AUDIO_OUTPUT_FORMATS.copy.ext}`);
  const wavPath = path.join(outputDir, `${baseName}${AUDIO_OUTPUT_FORMATS.wav.ext}`);

  const copy = await runFfmpeg(
    ["-i", videoPath, "-vn", "-map", "a:0", "-acodec", "copy", "-f", "mp4", "-y", copyPath],
    FFMPEG_AUDIO_TIMEOUT_MS,
    { signal, stage: "audio_extract", logFields }
  );

  if (copy.code === 0) {
    // copy 偶发产出 0 字节：视为无有效音轨，交给回退阶段再判定一次
    const stat = await fs.stat(copyPath).catch(() => null);
    if (stat && stat.size > 0) {
      logEvent("media", { stage: "audio_extract_copy", ...logFields });
      return { path: copyPath, format: "copy", ...AUDIO_OUTPUT_FORMATS.copy };
    }
  } else if (isMissingStream(copy.stderr)) {
    throw new NoAudioTrackError();
  }
  await fs.rm(copyPath, { force: true }).catch(() => undefined);

  const wav = await runFfmpeg(
    [
      "-i", videoPath, "-vn", "-map", "a:0",
      "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2",
      "-f", "wav", "-y", wavPath,
    ],
    FFMPEG_AUDIO_TIMEOUT_MS,
    { signal, stage: "audio_extract_wav", logFields }
  );

  if (wav.code !== 0) {
    if (isMissingStream(wav.stderr)) throw new NoAudioTrackError();
    logEvent("media", {
      stage: "audio_extract_failed",
      exitCode: wav.code,
      stderr: wav.stderr.slice(-200),
      ...logFields,
    });
    throw exitError(wav.code, wav.stderr);
  }

  logEvent("media", { stage: "audio_extract_wav", ...logFields });
  return { path: wavPath, format: "wav", ...AUDIO_OUTPUT_FORMATS.wav };
}

/**
 * 抽离静音视频：视频流原样拷贝并丢弃音轨，不重新编码。
 * 输出容器沿用源扩展名；MP4 系追加 faststart 把 moov 前置，
 * 避免 <video> 必须等整个文件下载完才能起播。
 */
export async function extractMutedVideo(
  videoPath: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const args = ["-i", videoPath, "-map", "0:v:0", "-c:v", "copy", "-an"];
  if (/^\.(mp4|mov|m4v)$/i.test(path.extname(outputPath))) {
    args.push("-movflags", "+faststart");
  }
  args.push("-y", outputPath);

  const logFields = { video: path.basename(videoPath) };
  const run = await runFfmpeg(args, FFMPEG_AUDIO_TIMEOUT_MS, { signal, stage: "muted_video_extract", logFields });
  if (run.code !== 0) {
    logEvent("media", {
      stage: "muted_video_extract_failed",
      exitCode: run.code,
      stderr: run.stderr.slice(-200),
      ...logFields,
    });
    throw exitError(run.code, run.stderr);
  }

  logEvent("media", { stage: "muted_video_extract", ...logFields });
}

export interface ExtractedClip {
  /** 产物临时路径（调用方落盘后负责清理所在临时目录） */
  path: string;
  ext: string;
  mime: string;
}

/**
 * 截取视频片段（spawn ffmpeg）。
 *
 * 帧精确的重编码：输入 seek（`-ss` 在 `-i` 前）下 ffmpeg 从 seek 落点所在 GOP
 * 起点解码、丢弃到 start 为止的帧后开始编码，起点与播放器里看到的完全一致。
 * 刻意不做流拷贝（-c copy）快路径：切点会吸附关键帧（起点提前、包含多余内容），
 * 时间戳重排还可能带来音画错位与爆音——正确性优先于速度。
 *
 * 音轨用可选流映射（0:a:0?）：无音轨源静默产出纯视频，而不是整次失败。
 * 不 clamp end：-t 超出数据末端时 ffmpeg 自然停在 EOF，正是截断文件想要的行为。
 */
export async function extractVideoClip(
  videoPath: string,
  outputPath: string,
  range: { start: number; end: number },
  signal?: AbortSignal,
): Promise<ExtractedClip> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // start 靠近 0 时输入 seek 会退化为全片解码起点，本身无害；钳到 0 避免 -ss 0 的冗余
  const start = Math.max(0, range.start);
  const duration = Math.max(0, range.end - start);

  const logFields = { video: path.basename(videoPath) };
  const run = await runFfmpeg(
    [
      "-ss", start.toFixed(3), "-i", videoPath, "-t", duration.toFixed(3),
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      "-y", outputPath,
    ],
    FFMPEG_CLIP_TIMEOUT_MS,
    { signal, stage: "clip_extract", logFields }
  );

  if (run.code !== 0) {
    logEvent("media", {
      stage: "clip_extract_failed",
      exitCode: run.code,
      stderr: run.stderr.slice(-200),
      ...logFields,
    });
    throw exitError(run.code, run.stderr);
  }

  // 区间整体落在数据末端之外时会产出 0 字节：当作失败处理
  const stat = await fs.stat(outputPath).catch(() => null);
  if (!stat || stat.size === 0) {
    logEvent("media", { stage: "clip_extract_empty", ...logFields });
    throw new Error("Clip extraction produced an empty file");
  }

  logEvent("media", { stage: "clip_extract", ...logFields });

  return { path: outputPath, ext: ".mp4", mime: "video/mp4" };
}

/**
 * 截取音频片段（spawn ffmpeg）：音频流直接 copy，不重编码。
 * 音频帧只有 ~20ms，copy 的切点误差远低于体感阈值，无损且秒级完成；
 * 输出文件名（含扩展名）由路由按源扩展名决定，产物容器与源一致。
 * 不 clamp end：-t 超出数据末端时 ffmpeg 自然停在 EOF，正是截断文件想要的行为。
 */
export async function extractAudioClip(
  audioPath: string,
  outputPath: string,
  range: { start: number; end: number },
  signal?: AbortSignal,
): Promise<{ path: string }> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const start = Math.max(0, range.start);
  const duration = Math.max(0, range.end - start);

  const logFields = { audio: path.basename(audioPath) };
  const run = await runFfmpeg(
    [
      "-ss", start.toFixed(3), "-i", audioPath, "-t", duration.toFixed(3),
      "-map", "0:a:0",
      "-c:a", "copy",
      "-y", outputPath,
    ],
    FFMPEG_CLIP_TIMEOUT_MS,
    { signal, stage: "audio_clip_extract", logFields }
  );

  if (run.code !== 0) {
    logEvent("media", {
      stage: "audio_clip_extract_failed",
      exitCode: run.code,
      stderr: run.stderr.slice(-200),
      ...logFields,
    });
    throw exitError(run.code, run.stderr);
  }

  // 区间整体落在数据末端之外时会产出 0 字节：当作失败处理
  const stat = await fs.stat(outputPath).catch(() => null);
  if (!stat || stat.size === 0) {
    logEvent("media", { stage: "audio_clip_extract_empty", ...logFields });
    throw new Error("Audio clip extraction produced an empty file");
  }

  logEvent("media", { stage: "audio_clip_extract", ...logFields });

  return { path: outputPath };
}

/**
 * 音频变速（spawn ffmpeg）：atempo 滤镜重编码，保留音调。
 * atempo 单级限 0.5–2，超出范围链式拆分（0.25 = 0.5×0.5，4 = 2×2）。
 * 产物统一重编码为 m4a（aac 128k）：变速必须重编码，容器固定以简化产物管理。
 */
export async function changeAudioSpeed(
  audioPath: string,
  outputPath: string,
  speed: number,
  signal?: AbortSignal,
): Promise<{ path: string }> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    filters.push("atempo=2.0");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining *= 2;
  }
  filters.push(`atempo=${remaining.toFixed(6)}`);

  const logFields = { audio: path.basename(audioPath) };
  const run = await runFfmpeg(
    [
      "-i", audioPath, "-map", "0:a:0",
      "-af", filters.join(","),
      "-c:a", "aac", "-b:a", "128k",
      "-y", outputPath,
    ],
    FFMPEG_CLIP_TIMEOUT_MS,
    { signal, stage: "audio_speed", logFields: { ...logFields, speed } }
  );

  if (run.code !== 0) {
    logEvent("media", {
      stage: "audio_speed_failed",
      exitCode: run.code,
      stderr: run.stderr.slice(-200),
      ...logFields,
      speed,
    });
    throw exitError(run.code, run.stderr);
  }

  const stat = await fs.stat(outputPath).catch(() => null);
  if (!stat || stat.size === 0) {
    logEvent("media", { stage: "audio_speed_empty", ...logFields });
    throw new Error("Audio speed change produced an empty file");
  }

  logEvent("media", { stage: "audio_speed", ...logFields, speed });

  return { path: outputPath };
}

/**
 * 裁剪视频画面区域（spawn ffmpeg）：重编码整段视频，画面按矩形裁剪。
 * 与片段截取共用重编码参数与产物规格（mp4 / h264+aac）。
 * 矩形必须已按源分辨率钳位且宽高为偶数（yuv420p 的色度采样要求），
 * 由调用方（路由）在探明源分辨率后完成钳位。
 */
export async function cropVideoRegion(
  videoPath: string,
  outputPath: string,
  rect: { x: number; y: number; width: number; height: number },
  signal?: AbortSignal,
): Promise<ExtractedClip> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const { width, height, x, y } = rect;
  const logFields = { video: path.basename(videoPath) };
  const run = await runFfmpeg(
    [
      "-i", videoPath,
      "-vf", `crop=${width}:${height}:${x}:${y}`,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      "-y", outputPath,
    ],
    FFMPEG_CLIP_TIMEOUT_MS,
    { signal, stage: "crop_video", logFields }
  );

  if (run.code !== 0) {
    logEvent("media", {
      stage: "crop_video_failed",
      exitCode: run.code,
      stderr: run.stderr.slice(-200),
      ...logFields,
    });
    throw exitError(run.code, run.stderr);
  }

  const stat = await fs.stat(outputPath).catch(() => null);
  if (!stat || stat.size === 0) {
    logEvent("media", { stage: "crop_video_empty", ...logFields });
    throw new Error("Video crop produced an empty file");
  }

  logEvent("media", { stage: "crop_video", ...logFields });

  return { path: outputPath, ext: ".mp4", mime: "video/mp4" };
}
