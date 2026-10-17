/**
 * 客户端流式哈希（specs/storage-s3-backend.md 业务规则 6）。
 * hash-wasm 增量实现：file.stream() 逐块读取，内容不整份驻留内存——
 * 大文件（上限 100MB+）不能走 crypto.subtle.digest（要求整 Buffer）。
 */
import { createSHA256 } from "hash-wasm";

/** 流式计算文件 SHA256（64 位小写十六进制，与 file_objects.hash 同一命名空间） */
export async function computeFileSha256(file: File, signal?: AbortSignal): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  const reader = file.stream().getReader();
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return hasher.digest("hex");
}
