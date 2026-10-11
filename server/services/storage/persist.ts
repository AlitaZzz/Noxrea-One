/**
 * 文件持久化。
 * 将下载或上传的文件以哈希去重方式写入存储并登记文件对象元数据。
 */

import { upsertFileObject } from "@server/crud/file";
import { buildStorageKey } from "./service";
import { probePersistedMediaMeta } from "./media-probe";
import { getVideoPosterWebP } from "./resize-cache";
import { logEvent } from "@server/core/logger/utils";

export interface FilePersistenceInput {
  userId: number;
  hash: string;
  size: number;
  mimeType: string;
  ext: string;
  source?: string;
}

/** 本次写入 file_objects 的媒体元数据（探测失败的字段为 null） */
export interface PersistedMediaMeta {
  width: number | null;
  height: number | null;
  duration: number | null;
}

/** 海报预热宽度：画布视频节点静止态的一档缩略图（与前端 ?w=480 请求同一缓存） */
const VIDEO_POSTER_PREWARM_WIDTH = 480;

/**
 * 视频落库后预热首帧海报（fire-and-forget）。
 * getVideoPosterWebP 内部自带缓存命中短路、失败吞错与日志，这里只负责触发；
 * 失败不影响落盘结果，客户端首次 ?w= 请求仍会按需补生成。
 */
function prewarmVideoPoster(storageKey: string): void {
  void getVideoPosterWebP(storageKey, VIDEO_POSTER_PREWARM_WIDTH);
}

/**
 * 去重 + 写 file_objects 表。
 * 对齐 Python save_upload_bytes 的 INSERT + IntegrityError 去重逻辑。
 * 媒体元数据（宽高 / 时长）在落盘点一次性探测入库，下游统一读 DB，不再各自探测；
 * 探测是 best-effort，失败留 null，不阻塞落盘。
 * DB 写入失败时向上抛错，调用方据此让本次请求/任务失败；
 * 刚落盘的文件不删除——DB 不可用时无法确认该 hash 是否已被其他记录引用，
 * 误删会破坏已有对象，孤儿文件交由 GC 对账清理。
 */
export async function persistFileObject(data: FilePersistenceInput): Promise<PersistedMediaMeta> {
  try {
    const storageKey = buildStorageKey(data.userId, data.hash, data.ext);
    const meta = await probePersistedMediaMeta(storageKey, data.mimeType).catch(() => null);

    const persistedMeta: PersistedMediaMeta = {
      width: meta?.width ?? null,
      height: meta?.height ?? null,
      duration: meta?.duration ?? null,
    };

    await upsertFileObject({
      userId: data.userId,
      hash: data.hash,
      size: data.size,
      mimeType: data.mimeType,
      ext: data.ext,
      source: data.source ?? "generated",
      ...persistedMeta,
    });

    logEvent("storage", {
      stage: "persisted",
      user: data.userId,
      hash: data.hash,
      size: data.size,
      source: data.source,
    });

    if (data.mimeType.startsWith("video/")) {
      prewarmVideoPoster(storageKey);
    }

    return persistedMeta;
  } catch (err: unknown) {
    // 记录完整错误信息，便于排查 DB 写入失败的真实原因
    const details = err instanceof Error
      ? { error: err.message, stack: err.stack }
      : { error: String(err) };
    const code = typeof err === "object" && err !== null && "code" in err
      ? err.code
      : undefined;
    logEvent("storage", {
      stage: "persist_error",
      user: data.userId,
      hash: data.hash,
      ...details,
      code,
    });
    throw err instanceof Error ? err : new Error(String(err));
  }
}
