// ── 媒体处理（对应 backend/app/services/media.py） ──

import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import { localStorage } from "./backends/local";
import { getConfig } from "@server/core/config";
import { logEvent } from "@server/core/logger/utils";

/**
 * 图片等比缩放 WebP 缓存
 * 对应 Python 的 sharp 缩放缓存
 */
export async function getResizedWebP(
  storageKey: string,
  width: number
): Promise<string | null> {
  const cacheKey = `_cache/${width}/${storageKey}`;

  // 检查缓存
  const cached = await localStorage.stat(cacheKey);
  if (cached) return cacheKey;

  try {
    const sharp = (await import("sharp")).default;

    // 用 localStorage 的 baseDir 统一路径
    const cachePath = path.resolve(localStorage.baseDir, cacheKey);
    const sourcePath = path.resolve(localStorage.baseDir, storageKey);

    await fs.mkdir(path.dirname(cachePath), { recursive: true });

    await sharp(sourcePath)
      .resize(width, undefined, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 75 })
      .toFile(cachePath);

    logEvent("media", { stage: "resize_cache", key: storageKey, width });

    return cacheKey;
  } catch (err: unknown) {
    // 如果 sharp 不可用或转换失败，静默返回 null
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logEvent("media", { stage: "resize_failed", key: storageKey, error: (err as Error).message });
    }
    return null;
  }
}

/**
 * 视频截帧（spawn ffmpeg）
 * 对应 Python 的 subprocess ffmpeg
 */
export async function captureVideoFrame(
  videoPath: string,
  outputPath: string,
  timeSeconds = 1
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const ffmpegBin = getConfig().FFMPEG_PATH;
    const ffmpeg = spawn(ffmpegBin, [
      "-ss", String(timeSeconds),
      "-i", videoPath,
      "-vframes", "1",
      "-q:v", "2",
      "-y",
      outputPath,
    ]);

    let stderr = "";
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        logEvent("media", {
          stage: "capture_frame",
          video: path.basename(videoPath),
        });
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200)}`));
      }
    });

    ffmpeg.on("error", reject);
  });
}

/**
 * 路径穿越防护：校验用户文件访问
 * 对应 Python validateUserFile
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
