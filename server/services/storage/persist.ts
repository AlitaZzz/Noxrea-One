/**
 * 文件持久化。
 * 将下载或上传的文件以哈希去重方式写入存储并登记文件对象元数据。
 */

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
      source: data.source ?? "generated",
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
  }
}
