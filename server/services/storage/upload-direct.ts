/**
 * 直传双模式（specs/storage-s3-backend.md 业务规则 6）。
 *
 * 支持预签名 PUT 的后端（S3 兼容对象存储）下，客户端绕开服务器中转：
 * ticket（秒传查询 + staging 票据）→ 客户端直 PUT 预签名 URL → complete（服务端提升）。
 * 提升不走「信任客户端」捷径：staging 归属校验后先拉流复验（SHA256 / 字节数 / XML 嗅探），
 * 验证通过才复制提升到内容寻址 key，与中转上传同一条落库口径
 * （persistFileObject：去重 upsert、媒体元数据探测、视频海报母版）。
 * 复验失败返回 422 且不提升——未验证内容绝不落内容寻址 key，因此并发完成请求间
 * 不存在「未验证内容覆盖先到对象」的破坏性竞态；staging 保留供排查，超龄由 GC 清扫。
 * 提升后落库失败（如 DB 不可用）保留已提升对象——无法确认 hash 引用
 * 情况时不删内容，孤儿对象交由对账清理（与 persist.ts 语义一致）。
 */

import { createHash, randomUUID } from "crypto";

import { prisma } from "@server/core/database/client";
import type { ErrorCode } from "@server/core/errors/codes";
import { logger } from "@server/core/logger";
import { getSetting } from "@server/core/settings";
import { evaluateUploadIdentity, resolveUploadMime } from "./formats";
import { mimeByExt, sniffMime, normalizeExt, SNIFF_WINDOW_BYTES } from "./mime";
import { persistFileObject } from "./persist";
import { probeUploadVideo, type VideoUploadWarning } from "./media-probe";
import { createXmlContentDetector } from "./xml-content";
import { buildStorageKey, getStorageBackend, storedFileView, type StoredFileView } from "./service";
import { supportsDirectUpload, STAGING_PREFIX } from "./backend";

/** staging key 形态校验（由 STAGING_PREFIX 常量拼装，前缀调整不漂移）：{prefix}{userId}/{uuid} */
const STAGING_KEY_RE = new RegExp(
  `^${STAGING_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
);
/** staging 超龄清扫阈值：完成流程很短，24h 足以覆盖一切中断场景 */
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 直传业务错误：路由层按携带的 status/code 直接映射响应 */
export class UploadDirectError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly ctx?: Record<string, string | number>,
  ) {
    super(code);
    this.name = "UploadDirectError";
  }
}

export type UploadTicket =
  | { duplicate: true; file: StoredFileView }
  | {
      duplicate: false;
      staging_key: string;
      upload_url: string;
      content_type: string;
    };

export interface DirectUploadResult {
  file: StoredFileView;
  media_warning?: VideoUploadWarning;
}

/** staging 清理是收尾而非正确性步骤：失败留痕，超龄清扫兜底 */
function cleanupStaging(stagingKey: string): Promise<void> {
  return getStorageBackend().delete(stagingKey).catch((err) => {
    logger.warn({ err, staging: stagingKey }, "staging cleanup failed; sweep will reclaim");
  });
}

/**
 * 直传票据：先查秒传（同用户同 hash 已有对象即直接返回），否则签发
 * staging 预签名 PUT。准入与中转同一口径（evaluateUploadIdentity：白名单 MIME
 * 或白名单扩展名任一命中即受理；无字节可嗅探，两侧皆缺即 415 快速失败）。
 * PUT Content-Type：白名单客户端 MIME 优先，否则由扩展名推导；解析结果回传，
 * 客户端 PUT 时须原样携带。
 */
export async function createUploadTicket(
  userId: number,
  input: { hash: string; size: number; name: string; contentType?: string },
): Promise<UploadTicket> {
  const backend = getStorageBackend();
  // 直传能力统一判定（与 mode/complete 同口径）：票据是直传链路入口，缺能力在此 fail-fast，
  // 客户端字节尚未出发，不会出现「票据已签发、完成必 409」的半链路
  if (!supportsDirectUpload(backend)) {
    throw new UploadDirectError(409, "upload.direct_unavailable");
  }

  const maxSizeMb = getSetting("upload.max_file_mb");
  if (input.size > maxSizeMb * 1024 * 1024) {
    throw new UploadDirectError(413, "upload.file_too_large", { limit: maxSizeMb });
  }
  const identity = evaluateUploadIdentity(input.name, input.contentType);
  if (!identity.admitted) {
    throw new UploadDirectError(415, "upload.unsupported_type", { type: identity.type });
  }

  // 秒传：内容寻址下同 hash 即同内容，直接返回既有对象，不占 staging
  const existing = await prisma.fileObject.findUnique({
    where: { userId_hash: { userId, hash: input.hash } },
  });
  if (existing) {
    return { duplicate: true, file: storedFileView(existing) };
  }

  const contentType = identity.whitelistedMime ?? mimeByExt(identity.nameExt);
  const stagingKey = `${STAGING_PREFIX}${userId}/${randomUUID()}`;
  const uploadUrl = await backend.presignPut(stagingKey, { contentType });
  return {
    duplicate: false,
    staging_key: stagingKey,
    upload_url: uploadUrl,
    content_type: contentType,
  };
}

/**
 * 完成直传：staging 拉流复验通过后复制提升到内容寻址 key，再走统一落库口径。
 * staging 归属编码在 key 的 {userId} 段，非本用户的 key 一律按不存在处理（404，
 * 不泄露他人 staging 的存在性）。
 */
export async function completeDirectUpload(
  userId: number,
  input: { stagingKey: string; hash: string; name: string; contentType?: string; source?: "upload" | "derived" },
): Promise<DirectUploadResult> {
  const backend = getStorageBackend();
  // 直传能力统一判定（与 mode/ticket 同口径）；谓词同时收窄 presignPut / copy
  if (!supportsDirectUpload(backend)) {
    throw new UploadDirectError(409, "upload.direct_unavailable");
  }

  const match = STAGING_KEY_RE.exec(input.stagingKey);
  if (!match || Number(match[1]) !== userId) {
    throw new UploadDirectError(404, "upload.staging_missing");
  }
  // 幂等重复完成：file_objects 行只在复验通过后写入，查得即代表同 hash 内容
  // 已完整走完提升流程，直接返回既有对象并尽力清走 staging（可能已不存在），
  // 不重复复制。检查先于 staging 存在性：首次成功已清 staging 的丢失响应重试同样幂等返回
  const existing = await prisma.fileObject.findUnique({
    where: { userId_hash: { userId, hash: input.hash } },
  });
  if (existing) {
    await cleanupStaging(input.stagingKey);
    return { file: storedFileView(existing) };
  }

  const stat = await backend.stat(input.stagingKey);
  if (!stat) {
    throw new UploadDirectError(404, "upload.staging_missing");
  }
  const maxSizeMb = getSetting("upload.max_file_mb");
  if (stat.size > maxSizeMb * 1024 * 1024) {
    await backend.delete(input.stagingKey);
    throw new UploadDirectError(413, "upload.file_too_large", { limit: maxSizeMb });
  }

  // 准入与中转同口径（evaluateUploadIdentity）；票据阶段已做同一判定，此处对直连 API 调用方兜底
  const identity = evaluateUploadIdentity(input.name, input.contentType);
  if (!identity.admitted) {
    throw new UploadDirectError(415, "upload.unsupported_type", { type: identity.type });
  }

  // 提升前复验 staging 源流（SHA256 + 字节数 + XML 判定，与中转共用同一状态机全量喂入）；
  // 失败 422 且 staging 保留供排查（超龄由清扫回收）——未验证内容绝不落内容寻址 key，
  // 并发完成请求之间不存在「未验证内容覆盖先到对象」的破坏性竞态
  const stream = await backend.get(input.stagingKey);
  const hash = createHash("sha256");
  const xmlDetector = createXmlContentDetector();
  const magic = Buffer.alloc(SNIFF_WINDOW_BYTES);
  let magicLen = 0;
  let size = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    hash.update(buf);
    size += buf.length;
    if (magicLen < magic.length) {
      const take = Math.min(magic.length - magicLen, buf.length);
      buf.copy(magic, magicLen, 0, take);
      magicLen += take;
    }
    xmlDetector.feed(buf);
  }
  if (hash.digest("hex") !== input.hash || size !== stat.size || xmlDetector.isXml()) {
    throw new UploadDirectError(422, "upload.verify_failed", { hash: input.hash });
  }

  // 扩展名与 MIME 定档与中转完全同源：名字扩展名可用则用之，否则按验流魔数嗅探
  // （normalizeExt 同一实现）；MIME 定档按名字扩展名 + 嗅探结果，忽略非白名单客户端值
  const sniffed = sniffMime(magic.subarray(0, magicLen));
  const finalExt = identity.extOk ? identity.nameExt : normalizeExt(sniffed.ext);
  const mime = resolveUploadMime(identity.whitelistedMime, identity.nameExt, sniffed.mime);
  const contentKey = buildStorageKey(userId, input.hash, finalExt);

  // 服务端复制提升（字节不出对象存储）；复制的必是已验证内容，同 hash 覆盖即同字节，幂等
  try {
    await backend.copy(input.stagingKey, contentKey);
  } catch (err) {
    // 复制中断可能在内容 key 留下不完整对象：清理后重抛，不允许半截内容存活
    await backend.delete(contentKey).catch((cleanupErr) => {
      logger.warn({ err: cleanupErr, key: contentKey }, "direct upload promote cleanup failed; audit will reclaim");
    });
    throw err;
  }

  // persistFileObject 内部做去重 upsert、媒体探测与视频海报母版；
  // DB 失败时保留已提升对象并向上抛错——无法确认 hash 引用情况时不删内容，
  // 孤儿对象交由审计对账（与 persist.ts 语义一致）
  const mediaMeta = await persistFileObject({
    userId,
    hash: input.hash,
    size: stat.size,
    mimeType: mime,
    ext: finalExt,
    source: input.source ?? "upload",
  });

  // 体检门槛（仅视频）内聚于 probeUploadVideo
  const mediaWarning = await probeUploadVideo(contentKey, userId);

  // staging 清理是收尾而非正确性步骤：失败留待超龄清扫兜底
  await cleanupStaging(input.stagingKey);

  return {
    file: storedFileView({
      userId,
      hash: input.hash,
      ext: finalExt,
      size: stat.size,
      mimeType: mime,
      width: mediaMeta.width,
      height: mediaMeta.height,
    }),
    ...(mediaWarning ? { media_warning: mediaWarning } : {}),
  };
}

/**
 * staging 清扫（挂接 GC 每日节奏）：超龄 staging 对象逐个删除。
 * 受 storage.gc_dry_run 护栏约束：开启时只统计不删除，与引用回收同一安全口径。
 * 单个删除失败不中断清扫（次日重试）；枚举失败向上抛由调用方记录。
 */
export async function sweepStagingObjects(): Promise<number> {
  const backend = getStorageBackend();
  const dryRun = getSetting("storage.gc_dry_run");
  const cutoff = Date.now() - STAGING_MAX_AGE_MS;
  let swept = 0;
  for (const entry of await backend.list(STAGING_PREFIX)) {
    // lastModifiedMs 缺失（0）按未到期处理：宁可多留一轮，不误删在途上传
    if (entry.lastModifiedMs <= 0 || entry.lastModifiedMs >= cutoff) continue;
    if (dryRun) {
      swept += 1;
      continue;
    }
    try {
      await backend.delete(entry.key);
      swept += 1;
    } catch (err) {
      logger.warn({ err, staging: entry.key }, "staging sweep delete failed; will retry next sweep");
    }
  }
  return swept;
}
