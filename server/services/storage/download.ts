/**
 * 远端结果下载。
 * 在 SSRF 校验后下载远程生成结果，计算哈希并持久化为文件对象。
 */

import { resolveAndValidate } from "@server/core/ssrf";
import { fetchWithTimeout } from "@server/core/http-client";
import { logEvent } from "@server/core/logger/utils";
import { logger } from "@server/core/logger";
import { getConfig } from "@server/core/config";
import { buildStorageKey } from "./service";
import { computeBufferHash, sniffMime, normalizeExt } from "./hash";
import { persistFileObject } from "./persist";
import { localStorage } from "./backends/local";

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
  taskId: string = ""
): Promise<string | null> {
  const cfg = getConfig();
  const maxSize = cfg.MAX_UPLOAD_SIZE_MB * 1024 * 1024;
  try {
    let buffer: Buffer;

    // data: URL
    if (cdnUrl.startsWith("data:")) {
      const match = cdnUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!match) {
        logger.warn({ taskId }, "Invalid data: URL format");
        return null;
      }
      buffer = Buffer.from(match[2], "base64");
      logEvent("storage.download", { stage: "decoded_data_url", taskId, size: buffer.length });
    }
    // 远端下载
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
                await reader.cancel();
                logger.warn({ taskId, size: totalSize, max: maxSize }, "Download exceeds size limit (stream)");
                return null;
              }
              chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
            }
          } finally {
            reader.releaseLock();
          }

          downloadedBuffer = Buffer.concat(chunks);
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

    // SHA256 + magic bytes 校验
    const fileHash = await computeBufferHash(buffer);
    const { mime, ext: sniffedExt } = sniffMime(buffer.subarray(0, 16));
    const fileExt = normalizeExt(sniffedExt);

    // 构建存储路径：{userId}/{hash[:2]}/{hash}{ext}
    const storageKey = buildStorageKey(userId, fileHash, fileExt);

    // 落盘统一交给存储后端：临时文件 + 原子 rename，目标被外部句柄短暂占用时自动退避重试。
    // 旧实现直接 writeFile 最终路径，且只按 EPERM 判定「文件被锁」——
    // 而 Windows 的共享冲突实际以 code=UNKNOWN（errno -4094）抛出，那个兜底从未生效过。
    await localStorage.save(storageKey, buffer);

    // 去重 + DB 记录
    await persistFileObject({
      userId,
      hash: fileHash,
      size: buffer.length,
      mimeType: mime,
      ext: fileExt,
      source: "generated",
    });

    return storageKey;
  } catch (err) {
    logger.error({ err, taskId }, "downloadAndSave failed");
    return null;
  }
}

