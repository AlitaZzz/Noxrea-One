/**
 * 批量上传服务。
 * 路由只负责认证、限流和请求解析；文件校验、落盘、去重和元数据持久化
 * 全部在这里按文件独立处理，避免一个坏文件阻断同批其他文件。
 */
import { getSetting } from "@server/core/settings";
import type { ErrorCode } from "@server/core/errors/codes";
import { computeBufferHash } from "./hash";
import { findQuotaViolation } from "./quota";
import { sniffMime, normalizeExt, SNIFF_WINDOW_BYTES } from "./mime";
import { isXmlContent } from "./xml-content";
import { evaluateUploadIdentity, resolveUploadMime } from "./formats";
import { probeUploadVideo, type VideoUploadWarning } from "./media-probe";
import { persistFileObject } from "./persist";
import { buildStorageKey, getStorageBackend, storedFileView, type StoredFileView } from "./service";
import { logger } from "@server/core/logger";

const FILE_PROCESS_CONCURRENCY = 3;

export interface UploadSuccess extends StoredFileView {
  media_warning?: VideoUploadWarning;
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

  const identity = evaluateUploadIdentity(file.name, file.type);
  if (!identity.admitted) {
    return itemError(index, "upload.unsupported_type", { type: identity.type });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    if (isXmlContent(buffer)) {
      return itemError(index, "upload.unsupported_type", { type: identity.type });
    }
    const hash = await computeBufferHash(buffer);

    // 存储配额预检（specs/storage-user-quota.md 规则 3）：去重感知判定——内容哈希算出后携带
    // dedupeHash，同 hash 既有行即幂等重添加（不产生净增占用）跳过判定，与直传秒传豁免同口径；
    // 净增内容按 file.size（multipart 真实接收字节数）判定，超限 itemError 隔离，批次不受牵连
    const quotaViolation = await findQuotaViolation(userId, file.size, { dedupeHash: hash });
    if (quotaViolation) return itemError(index, "upload.quota_exceeded", quotaViolation);
    const sniffed = sniffMime(buffer.subarray(0, SNIFF_WINDOW_BYTES));
    const mime = resolveUploadMime(identity.whitelistedMime, identity.nameExt, sniffed.mime);
    const finalExt = identity.extOk ? identity.nameExt : normalizeExt(sniffed.ext);
    const storageKey = buildStorageKey(userId, hash, finalExt);

    await getStorageBackend().put(storageKey, buffer);
    const mediaMeta = await persistFileObject({
      userId,
      hash,
      size: buffer.length,
      mimeType: mime,
      ext: finalExt,
      source,
    });

    // 体检门槛（仅视频）内聚于 probeUploadVideo
    const mediaWarning = await probeUploadVideo(storageKey, userId);

    return {
      index,
      ok: true,
      data: {
        ...storedFileView({
          userId,
          hash,
          ext: finalExt,
          size: buffer.length,
          mimeType: mime,
          width: mediaMeta.width,
          height: mediaMeta.height,
        }),
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
  // 批次处理入口读取一次下传，逐文件不再各自访问
  const maxSizeMb = getSetting("upload.max_file_mb");
  const results: UploadItemResult[] = [];
  for (let start = 0; start < files.length; start += FILE_PROCESS_CONCURRENCY) {
    const chunk = files.slice(start, start + FILE_PROCESS_CONCURRENCY);
    results.push(...await Promise.all(chunk.map((file, offset) => processFile(file, start + offset, userId, source, maxSizeMb))));
  }
  return { items: results.sort((a, b) => a.index - b.index) };
}
