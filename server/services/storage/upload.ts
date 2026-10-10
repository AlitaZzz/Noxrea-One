/**
 * 批量上传服务。
 * 路由只负责认证、限流和请求解析；文件校验、落盘、去重和元数据持久化
 * 全部在这里按文件独立处理，避免一个坏文件阻断同批其他文件。
 */
import path from "path";

import { getConfig } from "@server/core/config";
import type { ErrorCode } from "@server/core/errors/codes";
import { logEvent } from "@server/core/logger/utils";
import { computeBufferHash } from "./hash";
import { sniffMime, normalizeExt, mimeByExt } from "./mime";
import { probeVideoIntegrity, probeVideoMetaCached } from "./media-probe";
import { persistFileObject } from "./persist";
import { buildStorageKey } from "./service";
import { localStorage } from "./backends/local";
import { logger } from "@server/core/logger";

export const UPLOAD_FORMATS = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "avif"],
  video: ["mp4", "webm", "mov", "avi", "mkv"],
  audio: ["mp3", "wav", "ogg", "m4a", "aac", "flac", "webm"],
} as const;

const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "image/avif",
  "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo",
  "video/x-matroska",
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg",
  "audio/flac", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/x-aac", "audio/webm",
]);

const ALLOWED_EXT = new Set<string>(Object.values(UPLOAD_FORMATS).flat());
const FILE_PROCESS_CONCURRENCY = 3;
const UPLOAD_VIDEO_PROBE_TIMEOUT_MS = 1_500;

export interface UploadSuccess {
  key: string;
  url: string;
  size: number;
  mime_type: string;
  hash: string;
  width: number | null;
  height: number | null;
  media_warning?: { declared: number; decodable: number };
}

export interface UploadItemError {
  code: Extract<ErrorCode, `upload.${string}`>;
  ctx?: Record<string, string | number>;
}

export type UploadItemResult =
  | { index: number; ok: true; data: UploadSuccess }
  | { index: number; ok: false; error: UploadItemError };

export interface UploadBatchResult {
  items: UploadItemResult[];
}

function extOfName(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? `.${m[1].toLowerCase()}` : "";
}

/**
 * 白名单全是二进制媒体；XML 文本（含 SVG）不能凭伪造的文件名/MIME 获准上传。
 * 扫描首个非空白码元而非固定长度前缀，兼顾长注释/空白、UTF-8 BOM 和 UTF-16。
 * 不解码整份文件，也不误拒绝二进制媒体元数据中偶然包含的 <svg 字样。
 */
function isXmlContent(buffer: Buffer): boolean {
  let offset = 0;
  let step = 1;
  let littleEndian = true;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    offset = 2;
    step = 2;
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    offset = 2;
    step = 2;
    littleEndian = false;
  } else if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    offset = 3;
  } else if (buffer[0] === 0 && buffer[1] === 0x3c) {
    step = 2;
    littleEndian = false;
  } else if (buffer[0] === 0x3c && buffer[1] === 0) {
    step = 2;
  }
  for (; offset + step <= buffer.length; offset += step) {
    const code = step === 1 ? buffer[offset]
      : littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;
    return code === 0x3c;
  }
  return false;
}

/**
 * 视频上传体检：标称时长 vs 实际可解码时长。
 * 完整探测必须在当前批次返回前结束，确保并发租约覆盖整个媒体处理成本。
 */
async function probeUploadVideo(storageKey: string): Promise<UploadSuccess["media_warning"] | undefined> {
  const absPath = path.resolve(localStorage.baseDir, storageKey);
  try {
    const meta = await probeVideoMetaCached(absPath);
    if (!meta?.duration) return undefined;
    const integrity = await probeVideoIntegrity(absPath, meta.duration, UPLOAD_VIDEO_PROBE_TIMEOUT_MS);
    if (!integrity.truncated || !integrity.decodableDuration) return undefined;
    const warning = { declared: meta.duration, decodable: integrity.decodableDuration };
    logEvent("media", { stage: "upload_truncated", video: storageKey, ...warning });
    return warning;
  } catch (err: unknown) {
    logger.debug({ err, video: storageKey }, "upload probe failed");
    return undefined;
  }
}

function itemError(
  index: number,
  code: UploadItemError["code"],
  ctx?: Record<string, string | number>,
): UploadItemResult {
  return { index, ok: false, error: { code, ...(ctx ? { ctx } : {}) } };
}

async function processFile(
  file: File,
  index: number,
  userId: number,
  source: "upload" | "derived",
  maxSizeMb: number,
): Promise<UploadItemResult> {
  const maxSize = maxSizeMb * 1024 * 1024;
  if (file.size > maxSize) return itemError(index, "upload.file_too_large", { limit: maxSizeMb });

  const nameExt = extOfName(file.name);
  const mimeOk = Boolean(file.type) && ALLOWED_MIME.has(file.type);
  const extOk = nameExt !== "" && ALLOWED_EXT.has(nameExt.slice(1));
  if (!mimeOk && !extOk) {
    return itemError(index, "upload.unsupported_type", { type: file.type || nameExt || "unknown" });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    if (file.type === "image/svg+xml" || nameExt === ".svg" || isXmlContent(buffer)) {
      return itemError(index, "upload.unsupported_type", { type: file.type || nameExt || "svg" });
    }
    const hash = await computeBufferHash(buffer);
    const sniffed = sniffMime(buffer.subarray(0, 16));
    const mime = (file.type && mimeOk ? file.type : null) ?? mimeByExt(nameExt, sniffed.mime);
    const finalExt = extOk ? nameExt : normalizeExt(sniffed.ext);
    const storageKey = buildStorageKey(userId, hash, finalExt);

    await localStorage.save(storageKey, buffer);
    const mediaMeta = await persistFileObject({
      userId,
      hash,
      size: buffer.length,
      mimeType: mime,
      ext: finalExt,
      source,
    });

    let mediaWarning: UploadSuccess["media_warning"];
    if (/\.(mp4|webm|mov|mkv|m4v|avi|mpg|mpeg)$/i.test(finalExt)) {
      mediaWarning = await probeUploadVideo(storageKey);
    }

    return {
      index,
      ok: true,
      data: {
        key: storageKey,
        url: `/api/files/${storageKey}`,
        size: buffer.length,
        mime_type: mime,
        hash,
        width: mediaMeta.width,
        height: mediaMeta.height,
        ...(mediaWarning ? { media_warning: mediaWarning } : {}),
      },
    };
  } catch (err: unknown) {
    logger.error({ err, user: userId, file: file.name }, "Upload failed");
    return itemError(index, "upload.upload_failed");
  }
}

export async function processUploadBatch(
  files: File[],
  userId: number,
  source: "upload" | "derived",
): Promise<UploadBatchResult> {
  // 配置启动期缓存，批次处理入口读取一次下传，逐文件不再各自访问
  const maxSizeMb = getConfig().MAX_UPLOAD_SIZE_MB;
  const results: UploadItemResult[] = [];
  for (let start = 0; start < files.length; start += FILE_PROCESS_CONCURRENCY) {
    const chunk = files.slice(start, start + FILE_PROCESS_CONCURRENCY);
    results.push(...await Promise.all(chunk.map((file, offset) => processFile(file, start + offset, userId, source, maxSizeMb))));
  }
  return { items: results.sort((a, b) => a.index - b.index) };
}
