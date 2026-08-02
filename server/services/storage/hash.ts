// ── 增量 SHA256 + magic bytes 嗅探（对应 Python storage hash + media sniffMime） ──

import crypto from "crypto";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";

/** magic bytes 签名表 */
const MAGIC_SIGNATURES: Array<{ bytes: number[]; mime: string; ext: string; offset?: number }> = [
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg", ext: ".jpg" },
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: "image/png", ext: ".png" },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: "image/gif", ext: ".gif" },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: "image/webp", ext: ".webp" },
  { bytes: [0x66, 0x74, 0x79, 0x70], mime: "video/mp4", ext: ".mp4", offset: 4 },
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], mime: "video/webm", ext: ".webm" },
];

/** 嗅探文件 magic bytes 获取 MIME 类型 */
export function sniffMime(buffer: Buffer): { mime: string; ext: string } {
  for (const sig of MAGIC_SIGNATURES) {
    const start = sig.offset ?? 0;
    if (start + sig.bytes.length > buffer.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[start + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) return { mime: sig.mime, ext: sig.ext };
  }
  return { mime: "application/octet-stream", ext: ".bin" };
}

/** 归一化扩展名 */
export function normalizeExt(ext: string): string {
  if (!ext.startsWith(".")) ext = "." + ext;
  return ext.toLowerCase();
}

/** 增量计算文件 SHA256 */
export async function computeFileHash(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }

  return hash.digest("hex");
}

/** 增量计算 Buffer SHA256 */
export function computeBufferHash(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
