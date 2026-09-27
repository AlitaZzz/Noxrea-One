/**
 * 哈希计算。
 * 提供增量 SHA256 与 Buffer 哈希；MIME / 扩展名知识见同目录 mime.ts。
 */

import crypto from "crypto";
import { createReadStream } from "fs";

/** 增量计算文件 SHA256 */
export async function computeFileHash(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }

  return hash.digest("hex");
}

/** 异步计算 Buffer SHA256（不阻塞事件循环） */
export async function computeBufferHash(buffer: Buffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Buffer.from(hashBuffer).toString("hex");
}
