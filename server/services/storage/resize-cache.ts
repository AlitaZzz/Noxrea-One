/**
 * 媒体缩放缓存（`_cache/<w>/`）与视频海报母版（`_posters/`）。
 * specs/media-processing-concurrency.md 业务规则 8：
 * - 缩略图宽度只有 8 个档位，请求宽度向上取档，变体数有上限；
 * - 图片从原图直接缩放（sharp 池），原图即母版；
 * - 视频海报由每视频一份的高保真母版（ffmpeg 轻型池，落盘时生成）sharp 派生——
 *   解码贵、缩放便宜，ffmpeg 每视频恰好执行一次，其余档位毫秒级派生。
 * 生成受媒体池限流：媒体池过载抛 MediaPoolBusyError（不回退原图），其余失败返回 null。
 */

import path from "path";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { acquireMediaFile } from "./media-source";
import { logEvent } from "@server/core/logger/utils";
import { ensureArtifact } from "./artifact";
import { runFfmpegLight } from "./ffmpeg";
import { acquireMediaSlot, MediaPoolBusyError } from "./media-pool";

/** 缩略图宽度档位：全部来自前端调用点的实际宽度；1280 供视频节点海报（画布缩放 / retina） */
export const RESIZE_WIDTH_TIERS = [64, 112, 200, 300, 320, 400, 480, 1280] as const;

/** 海报母版参数：代码常量（结构性参数，不做运行期设置）；变更后 POSTER_VERSION +1 整体重生成 */
const POSTER_MASTER_MAX_WIDTH = 3840;
const POSTER_MASTER_QUALITY = 90;
const POSTER_VERSION = 1;

/** ffmpeg 抽帧超时：子进程若挂起会持续持有视频文件句柄，必须兜底杀掉 */
const FFMPEG_TIMEOUT_MS = 30_000;

/** 向上取档：请求宽度归一化到档位表（超过最大档一律最大档） */
export function normalizeResizeWidth(width: number): number {
  for (const tier of RESIZE_WIDTH_TIERS) {
    if (width <= tier) return tier;
  }
  return RESIZE_WIDTH_TIERS[RESIZE_WIDTH_TIERS.length - 1];
}

function cacheKeyOf(storageKey: string, tier: number): string {
  return `_cache/${tier}/${storageKey.replace(/\.[^.]+$/, "")}.webp`;
}

function posterMasterKey(storageKey: string): string {
  return `_posters/v${POSTER_VERSION}/${storageKey.replace(/\.[^.]+$/, "")}.webp`;
}

/**
 * 图片等比缩放 WebP 缓存（sharp，原图即母版）。
 * 过载（MediaPoolBusyError）向上抛出，其余失败静默为 null——两条路径必须可区分，
 * 路由层据此返回 503 而不是回退原图。
 */
export async function getResizedWebP(
  storageKey: string,
  width: number,
  signal?: AbortSignal
): Promise<string | null> {
  const tier = normalizeResizeWidth(width);
  const cacheKey = cacheKeyOf(storageKey, tier);

  try {
    await ensureArtifact({
      key: cacheKey,
      signal,
      produce: (tmpPath, genSignal) => produceImageWebP(storageKey, tmpPath, tier, genSignal),
    });
    return cacheKey;
  } catch (err: unknown) {
    if (err instanceof MediaPoolBusyError) throw err;
    // sharp 不可用或转换失败时静默返回 null（含客户端中断导致的 AbortError）
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && (err as Error).name !== "AbortError") {
      logEvent("media", { stage: "resize_failed", key: storageKey, error: (err as Error).message });
    }
    return null;
  }
}

/**
 * 视频海报缩略图（档位派生 + 磁盘缓存）。
 * 与图片共用 `_cache/<w>/` 目录；ffmpeg 只在母版缺失时执行一次（轻型池），
 * 档位一律由 sharp 从母版派生（sharp 池）。
 */
export async function getVideoPosterWebP(
  storageKey: string,
  width: number,
  signal?: AbortSignal
): Promise<string | null> {
  const tier = normalizeResizeWidth(width);
  const cacheKey = cacheKeyOf(storageKey, tier);

  try {
    await ensureArtifact({
      key: cacheKey,
      signal,
      produce: (tmpPath, genSignal) => producePosterTier(storageKey, tmpPath, tier, genSignal),
    });
    return cacheKey;
  } catch (err: unknown) {
    if (err instanceof MediaPoolBusyError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && (err as Error).name !== "AbortError") {
      logEvent("media", { stage: "video_poster_failed", key: storageKey, error: (err as Error).message });
    }
    return null;
  }
}

/**
 * 确保视频海报母版已生成（落盘时由 persist.ts 调用；档位派生前也经此补齐）。
 * 失败向上抛出：persist 层吞掉记日志（不阻塞落盘），档位派生层向上传播。
 */
export async function ensureVideoMasterPoster(storageKey: string): Promise<void> {
  await ensureArtifact({
    key: posterMasterKey(storageKey),
    produce: (tmpPath, genSignal) => producePosterMaster(storageKey, tmpPath, genSignal),
  });
}

/**
 * ffmpeg 抽首帧产出高保真母版（轻型池，由 runFfmpegLight 获取）。
 * 宽度 min(源宽, 3840)：解码一次覆盖全部现在与未来的档位。
 * -ss 0 取第一帧（seek 开销最小）；scale 用 min() 避免小源被放大。
 */
async function producePosterMaster(
  storageKey: string,
  outputPath: string,
  signal: AbortSignal
): Promise<void> {
  const source = await acquireMediaFile(storageKey, signal);
  try {
    const logFields = { video: path.basename(source.path) };
    const { code, stderr } = await runFfmpegLight(
      [
        "-ss", "0",
        "-i", source.path,
        "-frames:v", "1",
        "-vf", `scale='min(${POSTER_MASTER_MAX_WIDTH},iw)':-2`,
        "-c:v", "libwebp",
        "-quality", String(POSTER_MASTER_QUALITY),
        "-y",
        outputPath,
      ],
      FFMPEG_TIMEOUT_MS,
      { signal, stage: "poster_master", logFields }
    );

    if (code !== 0) {
      logEvent("media", {
        stage: "poster_master_failed",
        exitCode: code,
        stderr: stderr.slice(-200),
        ...logFields,
      });
      throw new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200)}`);
    }

    logEvent("media", { stage: "poster_master", ...logFields });
  } finally {
    await source.release();
  }
}

/** 档位派生：先确保母版存在（必要时 ffmpeg 一次），再由 sharp 从母版缩放 */
async function producePosterTier(
  storageKey: string,
  tmpPath: string,
  tier: number,
  signal: AbortSignal
): Promise<void> {
  const masterKey = posterMasterKey(storageKey);
  await ensureArtifact({
    key: masterKey,
    signal,
    produce: (tmpPath, genSignal) => producePosterMaster(storageKey, tmpPath, genSignal),
  });

  const master = await acquireMediaFile(masterKey, signal);
  const sharp = (await import("sharp")).default;

  const releaseSlot = await acquireMediaSlot("sharp", signal);
  try {
    // 源文件句柄交给 Node 的 createReadStream 持有（理由同 produceImageWebP）；
    // withoutEnlargement：小源视频的大档位不放大，实际宽度 = 源宽
    await pipeline(
      createReadStream(master.path, { signal }),
      sharp()
        .resize(tier, undefined, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 75 }),
      createWriteStream(tmpPath),
    );
  } finally {
    releaseSlot();
    await master.release();
  }

  logEvent("media", { level: "debug", stage: "video_poster_tier", key: storageKey, width: tier });
}

/** sharp 缩放：占 sharp 池一个槽位，管线结束 / 失败后释放 */
async function produceImageWebP(
  storageKey: string,
  tmpPath: string,
  tier: number,
  signal: AbortSignal,
): Promise<void> {
  const sharp = (await import("sharp")).default;
  const source = await acquireMediaFile(storageKey, signal);

  const releaseSlot = await acquireMediaSlot("sharp", signal);
  try {
    // 源文件句柄交给 Node 的 createReadStream 持有，而不是让 sharp 自行按路径打开：
    // sharp/libvips 的 native 句柄不受 Node 流体系管辖，中断时无法及时释放，
    // 会把源文件锁住，导致同 hash 文件再次上传时 writeFile/rename 失败。
    // 传入 signal 后，生成被取消时会立即销毁流并释放句柄。
    await pipeline(
      createReadStream(source.path, { signal }),
      sharp()
        .resize(tier, undefined, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 75 }),
      createWriteStream(tmpPath),
    );
  } finally {
    releaseSlot();
    await source.release();
  }

  logEvent("media", { level: "debug", stage: "resize_cache", key: storageKey, width: tier });
}
