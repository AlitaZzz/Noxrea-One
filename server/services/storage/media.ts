/**
 * 媒体处理。
 * 基于 ffmpeg 提供视频抽帧、转码与缩略图等本地媒体处理能力。
 */

import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import { localStorage } from "./backends/local";
import { getConfig } from "@server/core/config";
import { resolveFromRoot } from "@server/core/paths";
import { logEvent } from "@server/core/logger/utils";
import { withRetry } from "./fs-utils";

/** 缩放宽度上限：避免 w 被传成极大值，导致 sharp 长时间占用内存与源文件句柄 */
const MAX_RESIZE_WIDTH = 2048;

/** ffmpeg 抽帧超时：子进程若挂起会持续持有视频文件句柄，必须兜底杀掉 */
const FFMPEG_TIMEOUT_MS = 30_000;

/** 解析 ffmpeg 可执行文件路径：FFMPEG_PATH 为目录，根据 OS 拼接 ffmpeg / ffmpeg.exe */
function resolveFfmpegPath(configDir: string): string {
  const dir = path.isAbsolute(configDir)
    ? configDir
    : resolveFromRoot(configDir);
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return path.join(dir, exe);
}

/**
 * 图片等比缩放 WebP 缓存
 * sharp 缩放缓存
 */
export async function getResizedWebP(
  storageKey: string,
  width: number,
  signal?: AbortSignal
): Promise<string | null> {
  // 收敛到合法区间：非数字 / 负值 / 超大值都不应放大成一次重型缩放任务
  const safeWidth = Math.min(Math.max(1, Math.floor(width) || 1), MAX_RESIZE_WIDTH);
  const cacheKey = `_cache/${safeWidth}/${storageKey.replace(/\.[^.]+$/, "")}.webp`;

  // 缓存命中：0 字节视为未命中——那是上次生成被打断留下的残骸，必须重新生成
  const cached = await localStorage.stat(cacheKey);
  if (cached && cached.size > 0) return cacheKey;
  if (cached) await localStorage.delete(cacheKey).catch(() => undefined);

  try {
    const sharp = (await import("sharp")).default;

    // 用 localStorage 的 baseDir 统一路径
    const cachePath = path.resolve(localStorage.baseDir, cacheKey);
    const sourcePath = path.resolve(localStorage.baseDir, storageKey);

    await fs.mkdir(path.dirname(cachePath), { recursive: true });

    // 先写临时文件再原子替换，避免并发请求读到尚未写完的 webp
    const tmpPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      // 源文件句柄交给 Node 的 createReadStream 持有，而不是让 sharp 自行按路径打开：
      // sharp/libvips 的 native 句柄不受 Node 流体系管辖，中断时无法及时释放，
      // 会把源文件锁住，导致同 hash 文件再次上传时 writeFile/rename 失败。
      // 传入 signal 后，客户端断开会立即销毁流并释放句柄。
      await pipeline(
        createReadStream(sourcePath, signal ? { signal } : undefined),
        sharp()
          .resize(safeWidth, undefined, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 75 }),
        createWriteStream(tmpPath),
      );

      await withRetry(() => fs.rename(tmpPath, cachePath), { retries: 4 });
    } finally {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    }

    logEvent("media", { level: "debug", stage: "resize_cache", key: storageKey, width: safeWidth });

    return cacheKey;
  } catch (err: unknown) {
    // sharp 不可用或转换失败时静默返回 null（含客户端中断导致的 AbortError）
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && (err as Error).name !== "AbortError") {
      logEvent("media", { stage: "resize_failed", key: storageKey, error: (err as Error).message });
    }
    return null;
  }
}

/**
 * 视频缩略图（海报帧）惰性生成 + 磁盘缓存。
 * 与图片 getResizedWebP 共用 `_cache/<w>/` 目录与「临时文件 + 原子替换」策略：
 * 客户端请求 /api/files/<video>?w=200 时按需用 ffmpeg 抽第一帧并缩放为 webp。
 */
export async function getVideoPosterWebP(
  storageKey: string,
  width: number,
  signal?: AbortSignal
): Promise<string | null> {
  const safeWidth = Math.min(Math.max(1, Math.floor(width) || 1), MAX_RESIZE_WIDTH);
  const cacheKey = `_cache/${safeWidth}/${storageKey.replace(/\.[^.]+$/, "")}.webp`;

  // 缓存命中：0 字节视为未命中——那是上次生成被打断留下的残骸，必须重新生成
  const cached = await localStorage.stat(cacheKey);
  if (cached && cached.size > 0) return cacheKey;
  if (cached) await localStorage.delete(cacheKey).catch(() => undefined);

  try {
    const cachePath = path.resolve(localStorage.baseDir, cacheKey);
    const sourcePath = path.resolve(localStorage.baseDir, storageKey);

    await fs.mkdir(path.dirname(cachePath), { recursive: true });

    // 先写临时文件再原子替换，避免并发请求读到尚未写完的 webp
    const tmpPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await captureVideoPoster(sourcePath, tmpPath, safeWidth, signal);
      await withRetry(() => fs.rename(tmpPath, cachePath), { retries: 4 });
    } finally {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    }

    logEvent("media", { level: "debug", stage: "video_poster_cache", key: storageKey, width: safeWidth });

    return cacheKey;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && (err as Error).name !== "AbortError") {
      logEvent("media", { stage: "video_poster_failed", key: storageKey, error: (err as Error).message });
    }
    return null;
  }
}

/**
 * ffmpeg 抽第一帧并等比缩放到目标宽度，一步输出 webp。
 * -ss 0 取第一帧（seek 开销最小）；scale 用 min() 避免小图被放大。
 */
async function captureVideoPoster(
  videoPath: string,
  outputPath: string,
  width: number,
  signal?: AbortSignal
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const ffmpegBin = resolveFfmpegPath(getConfig().FFMPEG_PATH);
    const ffmpeg = spawn(ffmpegBin, [
      "-ss", "0",
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", `scale='min(${width},iw)':-2`,
      "-f", "webp",
      "-y",
      outputPath,
    ]);

    let stderr = "";
    let settled = false;

    /**
     * 超时兜底：ffmpeg 遇到损坏或特殊编码的视频可能永久挂起。
     * 未结束的子进程会一直持有视频文件句柄，Windows 上直接导致
     * 该视频后续无法被覆盖写入，且只有重启 Node 进程才能释放。
     */
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ffmpeg.kill("SIGKILL");
      logEvent("media", {
        stage: "video_poster_timeout",
        video: path.basename(videoPath),
        timeoutMs: FFMPEG_TIMEOUT_MS,
      });
      reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);

    /** 统一收口：只结算一次，并清理定时器与信号监听 */
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => {
      ffmpeg.kill("SIGKILL");
      settle(() => reject(new DOMException("Aborted", "AbortError")));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logEvent("media", { stage: "video_poster" });
        settle(resolve);
      } else {
        const errMsg = `ffmpeg exited with code ${code}: ${stderr.slice(-200)}`;
        logEvent("media", {
          stage: "video_poster_capture_failed",
          exitCode: code,
          stderr: stderr.slice(-200),
        });
        settle(() => reject(new Error(errMsg)));
      }
    });

    ffmpeg.on("error", (err) => {
      logEvent("media", {
        stage: "video_poster_spawn_failed",
        error: err.message,
        ffmpegBin,
      });
      settle(() => reject(err));
    });
  });
}

/**
 * 视频截帧（spawn ffmpeg）
 * 基于 subprocess 调用 ffmpeg
 */
export async function captureVideoFrame(
  videoPath: string,
  outputPath: string,
  timeSeconds = 1
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const ffmpegBin = resolveFfmpegPath(getConfig().FFMPEG_PATH);
    const ffmpeg = spawn(ffmpegBin, [
      "-ss", String(timeSeconds),
      "-i", videoPath,
      "-vframes", "1",
      "-q:v", "2",
      "-y",
      outputPath,
    ]);

    let stderr = "";
    let settled = false;

    /**
     * 超时兜底：ffmpeg 遇到损坏或特殊编码的视频可能永久挂起。
     * 未结束的子进程会一直持有视频文件句柄，Windows 上直接导致
     * 该视频后续无法被覆盖写入，且只有重启 Node 进程才能释放。
     */
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ffmpeg.kill("SIGKILL");
      logEvent("media", {
        stage: "capture_frame_timeout",
        video: path.basename(videoPath),
        timeoutMs: FFMPEG_TIMEOUT_MS,
      });
      reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);

    /** 统一收口：只结算一次，并清理定时器 */
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logEvent("media", {
          stage: "capture_frame",
          video: path.basename(videoPath),
        });
        settle(resolve);
      } else {
        const errMsg = `ffmpeg exited with code ${code}: ${stderr.slice(-200)}`;
        logEvent("media", {
          stage: "capture_frame_failed",
          video: path.basename(videoPath),
          exitCode: code,
          stderr: stderr.slice(-200),
        });
        settle(() => reject(new Error(errMsg)));
      }
    });

    ffmpeg.on("error", (err) => {
      logEvent("media", {
        stage: "capture_frame_spawn_failed",
        video: path.basename(videoPath),
        error: err.message,
        ffmpegBin,
      });
      settle(() => reject(err));
    });
  });
}

/** 音视频分离超时：即便 copy 也要完整读一遍长视频，抽帧的 30s 兜不住 */
const FFMPEG_AUDIO_TIMEOUT_MS = 120_000;

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

/**
 * ffmpeg 子进程通用执行器。
 * 统一处理超时兜底与客户端中断（signal）回收，并保证只结算一次。
 */
function runFfmpeg(
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const ffmpegBin = resolveFfmpegPath(getConfig().FFMPEG_PATH);
    const ffmpeg = spawn(ffmpegBin, args);
    let stderr = "";
    let settled = false;

    /**
     * 超时兜底：必须 SIGKILL。残留子进程会一直持有视频文件句柄，
     * Windows 上表现为该文件后续无法被覆盖写入。
     */
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ffmpeg.kill("SIGKILL");
      logEvent("media", { stage: "ffmpeg_timeout", timeoutMs });
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    /** 统一收口：只结算一次，并清理定时器与信号监听 */
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => {
      ffmpeg.kill("SIGKILL");
      settle(() => reject(new DOMException("Aborted", "AbortError")));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("close", (code) => settle(() => resolve({ code: code ?? -1, stderr })));

    ffmpeg.on("error", (err) => {
      logEvent("media", {
        stage: "ffmpeg_spawn_failed",
        error: err.message,
        ffmpegBin,
      });
      settle(() => reject(err));
    });
  });
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

  const copyPath = path.join(outputDir, `${baseName}${AUDIO_OUTPUT_FORMATS.copy.ext}`);
  const wavPath = path.join(outputDir, `${baseName}${AUDIO_OUTPUT_FORMATS.wav.ext}`);

  const copy = await runFfmpeg(
    ["-i", videoPath, "-vn", "-map", "a:0", "-acodec", "copy", "-f", "mp4", "-y", copyPath],
    FFMPEG_AUDIO_TIMEOUT_MS,
    signal,
  );

  if (copy.code === 0) {
    // copy 偶发产出 0 字节：视为无有效音轨，交给回退阶段再判定一次
    const stat = await fs.stat(copyPath).catch(() => null);
    if (stat && stat.size > 0) {
      logEvent("media", {
        stage: "audio_extract_copy",
        video: path.basename(videoPath),
      });
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
    signal,
  );

  if (wav.code !== 0) {
    if (isMissingStream(wav.stderr)) throw new NoAudioTrackError();
    logEvent("media", {
      stage: "audio_extract_failed",
      video: path.basename(videoPath),
      exitCode: wav.code,
      stderr: wav.stderr.slice(-200),
    });
    throw new Error(`ffmpeg exited with code ${wav.code}: ${wav.stderr.slice(-200)}`);
  }

  logEvent("media", {
    stage: "audio_extract_wav",
    video: path.basename(videoPath),
  });
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

  const run = await runFfmpeg(args, FFMPEG_AUDIO_TIMEOUT_MS, signal);
  if (run.code !== 0) {
    logEvent("media", {
      stage: "muted_video_extract_failed",
      video: path.basename(videoPath),
      exitCode: run.code,
      stderr: run.stderr.slice(-200),
    });
    throw new Error(`ffmpeg exited with code ${run.code}: ${run.stderr.slice(-200)}`);
  }

  logEvent("media", {
    stage: "muted_video_extract",
    video: path.basename(videoPath),
  });
}

/**
 * 路径穿越防护：校验用户文件访问
 * 校验用户文件合法性
 */
export function validateUserFile(
  filePath: string,
  baseDir: string
): boolean {
  const resolved = path.resolve(filePath);
  const base = path.resolve(baseDir);

  // 用前缀比对替代 startswith，防止 uploads/1x 绕过 uploads/1
  const normalized = resolved.replace(/\\/g, "/");
  const normalizedBase = base.replace(/\\/g, "/");

  return normalized.startsWith(normalizedBase + "/") || normalized === normalizedBase;
}
