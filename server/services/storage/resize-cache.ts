/**
 * 媒体缩放缓存（`_cache/v<版本>/<w>/`）与视频海报母版（`_posters/`）。
 * specs/canvas-media-resolution-lod.md 业务规则 8：
 * - 缩略图宽度档位单点在 `@noxrea/shared/media-tiers`（12 档，上限 2560），请求宽度向上取档，变体数有上限；
 * - 图片从原图直接缩放（sharp 池），原图即母版；
 * - 视频海报由每视频一份的高保真母版（ffmpeg 轻型池，落盘时生成）sharp 派生——
 *   解码贵、缩放便宜，ffmpeg 每视频恰好执行一次，其余档位毫秒级派生。
 * 生成受媒体池限流：媒体池过载抛 MediaPoolBusyError（不回退原图），其余失败返回 null。
 */

import path from "path";
import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { normalizeResizeWidth } from "@noxrea/shared/media-tiers";
import { cacheKeyOf, posterMasterKey } from "./derived-keys";
import { acquireMediaFile } from "./media-source";
import { logEvent } from "@server/core/logger/utils";
import { ArtifactSkipError, ensureArtifact } from "./artifact";
import { runFfmpegLight } from "./ffmpeg";
import { acquireMediaSlot, MediaPoolBusyError } from "./media-pool";

/** 海报母版参数：代码常量（结构性参数，不做运行期设置）；变更后 POSTER_VERSION +1 整体重生成 */
const POSTER_MASTER_MAX_WIDTH = 3840;
const POSTER_MASTER_QUALITY = 90;
const POSTER_VERSION = 1;

/** ffmpeg 抽帧超时：子进程若挂起会持续持有视频文件句柄，必须兜底杀掉 */
const FFMPEG_TIMEOUT_MS = 30_000;

/**
 * APNG 判定哨兵：由 getResizedWebP 捕获并回退原图，不能按生成失败记日志/指标。
 * 继承 `ArtifactSkipError` 使 `ensureArtifact` 记为 `skipped`（specs/canvas-media-resolution-lod.md 规则 8.8）。
 */
class AnimatedPngError extends ArtifactSkipError {
  constructor(storageKey: string) {
    super(`Animated PNG has no static derivation: ${storageKey}`);
    this.name = "AnimatedPngError";
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** chunk 遍历上限：畸形文件不可能无限循环（正常 PNG 只有少量 chunk） */
const MAX_PNG_CHUNKS = 10_000;

/**
 * APNG 识别（specs/canvas-media-resolution-lod.md 规则 8.8）：只读 PNG chunk 头，
 * 在首个 `IDAT` 前遇到 `acTL` 即判定为多帧 APNG。不整图解码、不依赖 sharp/libvips
 * 的 `pages` 行为；长度越过文件边界或 chunk 数超限按非 APNG 处理，后续 sharp 失败
 * 仍走原图兜底，不会死循环。
 */
export async function isAnimatedPng(filePath: string, signal?: AbortSignal): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
    if (size < PNG_SIGNATURE.length) return false;

    const signature = Buffer.alloc(PNG_SIGNATURE.length);
    const signatureRead = await handle.read(signature, 0, signature.length, 0);
    if (signatureRead.bytesRead !== signature.length || !signature.equals(PNG_SIGNATURE)) {
      return false;
    }

    let offset = PNG_SIGNATURE.length;
    const header = Buffer.alloc(8);
    for (let chunk = 0; chunk < MAX_PNG_CHUNKS; chunk++) {
      signal?.throwIfAborted();
      if (offset + header.length > size) return false;
      const read = await handle.read(header, 0, header.length, offset);
      if (read.bytesRead !== header.length) return false;

      const length = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      if (type === "acTL") return true;
      if (type === "IDAT" || type === "IEND") return false;

      const next = offset + header.length + length + 4; // 数据 + CRC
      if (!Number.isSafeInteger(next) || next > size) return false;
      offset = next;
    }
    return false;
  } finally {
    await handle.close();
  }
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
    if (err instanceof AnimatedPngError) {
      // APNG 不生成静态档位：路由按既有图片失败语义回退原图；不是生成失败
      logEvent("media", { level: "debug", stage: "apng_original", key: storageKey });
      return null;
    }
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
 * 与图片共用 `_cache/v<版本>/<w>/` 目录；ffmpeg 只在母版缺失时执行一次（轻型池），
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
    key: posterMasterKey(storageKey, POSTER_VERSION),
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
  const masterKey = posterMasterKey(storageKey, POSTER_VERSION);
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
  const source = await acquireMediaFile(storageKey, signal);
  try {
    // APNG 只能在解码前按 chunk 识别；命中哨兵后由 getResizedWebP 回退原图，
    // 不写静态档位、不占 sharp 槽位。扩展名大小写不敏感。
    if (path.extname(storageKey).toLowerCase() === ".png" && await isAnimatedPng(source.path, signal)) {
      throw new AnimatedPngError(storageKey);
    }

    const sharp = (await import("sharp")).default;
    const releaseSlot = await acquireMediaSlot("sharp", signal);
    try {
      // 源文件句柄交给 Node 的 createReadStream 持有，而不是让 sharp 自行按路径打开：
      // sharp/libvips 的 native 句柄不受 Node 流体系管辖，中断时无法及时释放，
      // 会把源文件锁住，导致同 hash 文件再次上传时 writeFile/rename 失败。
      // 传入 signal 后，生成被取消时会立即销毁流并释放句柄。
      // autoOrient 必须在 resize 前：手机 JPEG 的 EXIF Orientation 决定显示方向，
      // 不先定向会把缩略图旋转错（且会移除方向标签，浏览器无法再纠正）。
      await pipeline(
        createReadStream(source.path, { signal }),
        sharp()
          .autoOrient()
          .resize(tier, undefined, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 75 }),
        createWriteStream(tmpPath),
      );
    } finally {
      releaseSlot();
    }
  } finally {
    await source.release();
  }

  logEvent("media", { level: "debug", stage: "resize_cache", key: storageKey, width: tier });
}
