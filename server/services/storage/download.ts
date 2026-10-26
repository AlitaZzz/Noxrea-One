/**
 * 远端生成结果取字节与落盘。
 *
 * 三段分离（specs/generation-artifact-identity.md 规则 5/6）：
 * 1. fetchMediaBytes：候选地址 → 字节（data URL 本地解码 / 远端 SSRF 校验后下载）；
 * 2. identifyMediaBytes：字节 → 内容身份（SHA256 + magic bytes 嗅探 → 存储 key）；
 * 3. persistMediaBytes：身份 → 落盘 + file_objects 登记。
 *
 * 拆分的目的是让调用方在「落盘前」拿到身份，从而对同一身份只落盘一次；
 * 合并成单个 downloadAndSave 时，重复候选必然重复 put / 重复媒体探测。
 */

import { resolveAndValidate } from "@server/core/ssrf";
import { fetchWithTimeout } from "@server/core/http-client";
import { secondsToMs } from "@server/core/duration";
import { logEvent } from "@server/core/logger/utils";
import { logger } from "@server/core/logger";
import { getSetting } from "@server/core/settings";
import { buildStorageKey, getStorageBackend } from "./service";
import { computeBufferHash } from "./hash";
import { sniffMime, normalizeExt, SNIFF_WINDOW_BYTES } from "./mime";
import { persistFileObject } from "./persist";

/** 产物内容身份：key 是其唯一编码（{userId}/{hash[:2]}/{hash}{ext}） */
export interface MediaIdentity {
  key: string;
  hash: string;
  mimeType: string;
  ext: string;
}

/**
 * 解析 base64 data: URL 为原始字节。
 * mime 部分不做校验（真实类型由 sniffMime 从 magic bytes 探测），
 * 仅要求 `data:<任意 mime>;base64,<payload>` 结构；非 base64 data: URL 返回 null。
 */
export function decodeDataUrl(url: string): Buffer | null {
  const match = url.match(/^data:[^,]*;base64,([\s\S]+)$/);
  if (!match) return null;
  // 载荷中的空白（MIME 式回溯换行）不是数据本身，解码前剔除；
  // 其余字符必须落在 base64 / base64url 字母表内——Buffer.from 会静默丢弃
  // 非法字符，不校验就会把粘连的后续文本当成载荷解成垃圾字节并落盘。
  const payload = match[1].replace(/\s+/g, "");
  if (!payload || !/^[A-Za-z0-9+/=_-]+$/.test(payload)) return null;
  return Buffer.from(payload, "base64");
}

/**
 * 候选地址 → 字节。失败返回 null（已记日志，确定性失败不重试）。
 * - data: URL → 本地 base64 解码（零网络成本，同一字节只解码一次由调用方保证）；
 * - 远端 URL → SSRF 校验 → 下载（连接/body idle/overall 超时、尺寸上限、429/5xx 重试）。
 */
export async function fetchMediaBytes(candidate: string, taskId: string = ""): Promise<Buffer | null> {
  const maxSize = getSetting("upload.max_file_mb") * 1024 * 1024;
  try {
    // data: URL
    if (candidate.startsWith("data:")) {
      const decoded = decodeDataUrl(candidate);
      if (!decoded) {
        logger.warn({ taskId }, "Invalid data: URL format");
        return null;
      }
      // 与远端下载同样的体积上限：上游给的 data URL 不受 HTTP Content-Length 约束，
      // 没有这道闸门时超大载荷会绕开 upload.max_file_mb 直接落盘。
      if (decoded.length > maxSize) {
        logger.warn({ taskId, size: decoded.length, max: maxSize }, "data: URL exceeds size limit");
        return null;
      }
      logEvent("storage.download", { stage: "decoded_data_url", taskId, size: decoded.length });
      return decoded;
    }

    // SSRF 校验（确定性失败，不重试）
    try {
      const hostname = new URL(candidate).hostname;
      await resolveAndValidate(hostname);
    } catch {
      logger.warn({ taskId, url: candidate.slice(0, 120) }, "SSRF validation failed for download URL");
      return null;
    }

    // TCP 建连阶段超时（内置 15s，绕过 undici 默认的 10s 连接超时）
    const CONNECT_TIMEOUT_MS = 15_000;
    /** body 相邻数据块最大空闲：CDN 正常传输 chunk 间隔远小于此，超时即视为传输停摆 */
    const DOWNLOAD_BODY_IDLE_MS = 30_000;

    const MAX_DL_RETRIES = 3;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= MAX_DL_RETRIES; attempt++) {
      try {
        const response = await fetchWithTimeout(candidate, {
          scene: "dl",
          connectTimeoutMs: CONNECT_TIMEOUT_MS,
          // body idle：传输停摆及时终止；overall：防慢滴漏长期占用（上限仍受 upload.max_file_mb 约束）
          bodyIdleTimeoutMs: DOWNLOAD_BODY_IDLE_MS,
          overallTimeoutMs: secondsToMs(getSetting("http.download_total_timeout_seconds")),
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

        return Buffer.concat(chunks);
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

    logger.error({ err: lastErr, taskId }, "fetchMediaBytes failed after retries");
    return null;
  } catch (err) {
    logger.error({ err, taskId }, "fetchMediaBytes failed");
    return null;
  }
}

/**
 * 字节 → 内容身份。key 由 SHA256 与 magic bytes 嗅探确定，
 * 因此「同用户同字节」必得同 key（与上游 URL、字段名无关）。
 */
export async function identifyMediaBytes(buffer: Buffer, userId: number): Promise<MediaIdentity> {
  const fileHash = await computeBufferHash(buffer);
  const { mime, ext: sniffedExt } = sniffMime(buffer.subarray(0, SNIFF_WINDOW_BYTES));
  const fileExt = normalizeExt(sniffedExt);
  return {
    key: buildStorageKey(userId, fileHash, fileExt),
    hash: fileHash,
    mimeType: mime,
    ext: fileExt,
  };
}

/**
 * 身份 → 落盘 + file_objects 登记。
 * 同一身份在一个任务内只应调用一次（重复调用是对同一对象的重复写入与重复媒体探测）。
 */
export async function persistMediaBytes(
  buffer: Buffer,
  identity: MediaIdentity,
  userId: number
): Promise<void> {
  // 落盘统一交给存储后端：临时文件 + 原子 rename，目标被外部句柄短暂占用时自动退避重试。
  // 旧实现直接 writeFile 最终路径，且只按 EPERM 判定「文件被锁」——
  // 而 Windows 的共享冲突实际以 code=UNKNOWN（errno -4094）抛出，那个兜底从未生效过。
  await getStorageBackend().put(identity.key, buffer);

  await persistFileObject({
    userId,
    hash: identity.hash,
    size: buffer.length,
    mimeType: identity.mimeType,
    ext: identity.ext,
    source: "generated",
  });
}
