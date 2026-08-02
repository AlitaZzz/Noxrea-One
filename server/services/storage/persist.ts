// ── 文件持久化（对应 backend/app/services/storage/persist.py） ──

import { upsertFileObject } from "@server/crud/file";
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
 */
export async function persistFileObject(data: FilePersistenceInput) {
  try {
    await upsertFileObject({
      userId: data.userId,
      hash: data.hash,
      size: data.size,
      mimeType: data.mimeType,
      ext: data.ext,
      source: data.source ?? "ai_generated",
    });

    logEvent("storage", {
      stage: "persisted",
      user: data.userId,
      hash: data.hash,
      size: data.size,
      source: data.source,
    });
  } catch (err: any) {
    // IntegrityError → 去重命中，已存在同 hash 文件，静默忽略
    logEvent("storage", {
      stage: "dedup_hit",
      user: data.userId,
      hash: data.hash,
    });
  }
}
