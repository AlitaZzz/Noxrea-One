/**
 * 媒体缩放缓存（`_cache/<w>/`）。
 * 图片走 sharp 等比缩放，视频走 ffmpeg 抽首帧后缩放；共用「临时文件 + 原子
 * 替换 + withRetry」的缓存写入策略，缓存键由存储键与目标宽度派生。
 */

import path from "path";
import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import { localStorage } from "./backends/local";
import { isPathWithinBase } from "@server/core/paths";
import { logEvent } from "@server/core/logger/utils";
import { withRetry } from "./fs-utils";
import { runFfmpeg } from "./ffmpeg";

/** 缩放宽度上限：避免 w 被传成极大值，导致 sharp 长时间占用内存与源文件句柄 */
export const MAX_RESIZE_WIDTH = 2048;

/** ffmpeg 抽帧超时：子进程若挂起会持续持有视频文件句柄，必须兜底杀掉 */
const FFMPEG_TIMEOUT_MS = 30_000;

/** 收敛到合法区间：非数字 / 负值 / 超大值都不应放大成一次重型缩放任务 */
function safeCacheWidth(width: number): number {
  return Math.min(Math.max(1, Math.floor(width) || 1), MAX_RESIZE_WIDTH);
}

/** 缓存命中判定：0 字节视为未命中——那是上次生成被打断留下的残骸，必须重新生成 */
async function statFreshCache(cacheKey: string): Promise<boolean> {
  const cached = await localStorage.stat(cacheKey);
  if (cached && cached.size > 0) return true;
  if (cached) await localStorage.delete(cacheKey).catch(() => undefined);
  return false;
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
  // 存储层自带守卫：绝对路径 key（如 //etc/x.png、C:/x.png）不含 .. 段，
  // 可绕过路由层的 .. 检查，而缩放在路由校验 full path 之前执行。
  // isPathWithinBase 只接受绝对路径入参（相对路径会按 cwd 解析），必须先 resolve
  if (
    !isPathWithinBase(
      localStorage.baseDir,
      path.resolve(localStorage.baseDir, storageKey)
    )
  ) {
    return null;
  }

  const safeWidth = safeCacheWidth(width);
  const cacheKey = `_cache/${safeWidth}/${storageKey.replace(/\.[^.]+$/, "")}.webp`;
  if (await statFreshCache(cacheKey)) return cacheKey;

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
  if (
    !isPathWithinBase(
      localStorage.baseDir,
      path.resolve(localStorage.baseDir, storageKey)
    )
  ) {
    return null;
  }

  const safeWidth = safeCacheWidth(width);
  const cacheKey = `_cache/${safeWidth}/${storageKey.replace(/\.[^.]+$/, "")}.webp`;
  if (await statFreshCache(cacheKey)) return cacheKey;

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

  const logFields = { video: path.basename(videoPath) };
  const { code, stderr } = await runFfmpeg(
    [
      "-ss", "0",
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", `scale='min(${width},iw)':-2`,
      "-f", "webp",
      "-y",
      outputPath,
    ],
    FFMPEG_TIMEOUT_MS,
    { signal, stage: "video_poster", logFields }
  );

  if (code !== 0) {
    logEvent("media", {
      stage: "video_poster_capture_failed",
      exitCode: code,
      stderr: stderr.slice(-200),
      ...logFields,
    });
    throw new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200)}`);
  }

  logEvent("media", { stage: "video_poster" });
}
