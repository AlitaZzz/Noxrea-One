/**
 * 文件持久化。
 * 将下载或上传的文件以哈希去重方式写入存储并登记文件对象元数据。
 */

import { upsertFileObject } from "@server/crud/file";
import { buildStorageKey } from "./service";
import { probePersistedMediaMeta } from "./media";
import { logEvent } from "@server/core/logger/utils";

export interface FilePersistenceInput {
  userId: number;
  hash: string;
  size: number;
  mimeType: string;
  ext: string;
  source?: string;
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
export async function persistFileObject(data: FilePersistenceInput) {
  try {
    const meta = await probePersistedMediaMeta(
      buildStorageKey(data.userId, data.hash, data.ext),
      data.mimeType,
    ).catch(() => null);

    await upsertFileObject({
      userId: data.userId,
      hash: data.hash,
      size: data.size,
      mimeType: data.mimeType,
      ext: data.ext,
      source: data.source ?? "generated",
      width: meta?.width ?? null,
      height: meta?.height ?? null,
      duration: meta?.duration ?? null,
    });

    logEvent("storage", {
      stage: "persisted",
      user: data.userId,
      hash: data.hash,
      size: data.size,
      source: data.source,
    });
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
