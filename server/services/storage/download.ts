// ── 远端结果下载（对应 backend/app/services/storage/download.py） ──

import { resolveAndValidate } from "@server/core/ssrf";
import { fetchWithTimeout } from "@server/core/http-client";
import { logEvent } from "@server/core/logger/utils";
import { logger } from "@server/core/logger";
import { getConfig } from "@server/core/config";
import { resolveFromRoot } from "@server/core/paths";
import { buildStorageKey } from "./service";
import { computeBufferHash, sniffMime, normalizeExt } from "./hash";
import { persistFileObject } from "./persist";
import fs from "fs/promises";
import path from "path";

/**
 * 下载 + 落盘 + 去重（对齐 Python download_and_save）。
 *
 * 流程：
 * 1. data: URL → 直接 base64 解码 → SHA256 → hash[:2] 子目录 → persist
 * 2. 同源 URL → 跳过下载，直接返回
 * 3. 远端 URL → SSRF 校验 → 下载 → SHA256 → hash[:2] 子目录 → persist
 *
 * 返回存储 key（如 "3/04/04cf...png"），失败返回 null
 */
export async function downloadAndSave(
  cdnUrl: string,
  userId: number,
  capability: string,
  taskId: string = ""
): Promise<string | null> {
  const cfg = getConfig();
  const maxSize = cfg.MAX_UPLOAD_SIZE_MB * 1024 * 1024;
  // 初始扩展名仅作为 fallback，后续会通过 sniffMime 校正
  const ext = capability === "video" ? ".mp4" : capability === "audio" ? ".mp3" : ".png";

  logEvent("storage.download", {
    stage: "start",
    taskId,
    userId,
    capability,
    url: cdnUrl.slice(0, 120),
  });

  try {
    let buffer: Buffer;

    // ── data: URL ──
    if (cdnUrl.startsWith("data:")) {
      const match = cdnUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) {
        logger.warn({ taskId }, "Invalid data: URL format");
        return null;
      }
      buffer = Buffer.from(match[2], "base64");
      logEvent("storage.download", { stage: "decoded_data_url", taskId, size: buffer.length });
    }
    // ── 远端下载 ──
    else {
      // SSRF 校验（确定性失败，不重试）
      try {
        const hostname = new URL(cdnUrl).hostname;
        await resolveAndValidate(hostname);
      } catch {
        logger.warn({ taskId, url: cdnUrl.slice(0, 120) }, "SSRF validation failed for download URL");
        return null;
      }

      // TCP 建连阶段超时（内置 15s，绕过 undici 默认的 10s 连接超时）
      const CONNECT_TIMEOUT_MS = 15_000;

      const MAX_DL_RETRIES = 3;
      let lastErr: unknown;
      let downloadedBuffer: Buffer | undefined;

      for (let attempt = 1; attempt <= MAX_DL_RETRIES; attempt++) {
        try {
          const response = await fetchWithTimeout(cdnUrl, {
            scene: "dl",
            connectTimeoutMs: CONNECT_TIMEOUT_MS,
          });

          // 4xx（非 429）属于确定性失败，不重试
          if (response.status === 429 || response.status >= 500) {
            throw new Error(`retryable HTTP status ${response.status}`);
          }
          if (!response.ok) {
            logger.warn({ taskId, status: response.status }, "Download non-retryable HTTP error");
            return null;
          }

          // 流式读取 + 限流，避免大文件 OOM
          const contentLength = response.headers.get("content-length");
          const size = contentLength ? parseInt(contentLength, 10) : 0;
          if (size > maxSize) {
            logger.warn({ taskId, size, max: maxSize }, "Download exceeds size limit (via Content-Length)");
            return null;
          }

          const chunks: Buffer[] = [];
          let totalSize = 0;
          const reader = response.body?.getReader();
          if (!reader) {
            logger.warn({ taskId }, "Download response has no readable body");
            return null;
          }

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              totalSize += value.byteLength;
              if (totalSize > maxSize) {
                reader.cancel();
                logger.warn({ taskId, size: totalSize, max: maxSize }, "Download exceeds size limit (stream)");
                return null;
              }
              chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
            }
          } finally {
            reader.releaseLock();
          }

          downloadedBuffer = Buffer.concat(chunks);
          logEvent("storage.download", { stage: "downloaded", taskId, size: downloadedBuffer.length });
          break; // 成功，跳出重试循环
        } catch (err) {
          lastErr = err;
          // 仅在还有剩余重试次数时退避
          if (attempt < MAX_DL_RETRIES) {
            const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000); // 1s, 2s, 4s（上限 8s）
            logger.warn({ taskId, attempt, backoffMs, err }, "Download retryable failure, backing off");
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
        }
      }

      if (downloadedBuffer === undefined) {
        logger.error({ err: lastErr, taskId }, "downloadAndSave failed after retries");
        return null;
      }
      buffer = downloadedBuffer;
    }

    // ── SHA256 + magic bytes 校验 ──
    const fileHash = computeBufferHash(buffer);
    const { mime, ext: sniffedExt } = sniffMime(buffer.slice(0, 16));
    const fileExt = normalizeExt(sniffedExt);

    // ── 构建存储路径：{userId}/{hash[:2]}/{hash}{ext} ──
    const storageKey = buildStorageKey(userId, fileHash, fileExt);
    const uploadsRoot = resolveFromRoot(cfg.UPLOAD_DIR);
    const uploadsDir = path.resolve(uploadsRoot, path.dirname(storageKey));
    await fs.mkdir(uploadsDir, { recursive: true });
    const targetPath = path.resolve(uploadsRoot, storageKey);

    // 同内容同路径覆盖无影响
    try {
      await fs.writeFile(targetPath, buffer);
    } catch (err: unknown) {
      // Windows：文件被锁但内容相同，跳过
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        logger.warn({ taskId, path: targetPath }, "File locked, skipping write");
      } else {
        throw err;
      }
    }

    // ── 去重 + DB 记录 ──
    await persistFileObject({
      userId,
      hash: fileHash,
      size: buffer.length,
      mimeType: mime,
      ext: fileExt,
      source: "ai_generated",
    });

    logEvent("storage.download", {
      stage: "saved",
      taskId,
      key: storageKey,
      size: buffer.length,
      hash: fileHash,
    });

    return storageKey;
  } catch (err) {
    logger.error({ err, taskId }, "downloadAndSave failed");
    return null;
  }
}

