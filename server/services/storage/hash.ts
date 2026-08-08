/**
 * 哈希与媒体嗅探。
 * 提供增量 SHA256 计算与基于 magic bytes 的 MIME / 扩展名嗅探。
 */

import crypto from "crypto";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";

/** magic bytes 签名表（支持两段匹配：first + 可选 second） */
const MAGIC_SIGNATURES: Array<{
  bytes: number[];
  mime: string;
  ext: string;
  offset?: number;
  /** 第二段精确匹配，用于区分共享同一前缀的格式（如 RIFF→WEBP/WAVE） */
  second?: { bytes: number[]; offset: number };
}> = [
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg", ext: ".jpg" },
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: "image/png", ext: ".png" },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: "image/gif", ext: ".gif" },
  // WAV：RIFF....WAVE（与 webp 同为 RIFF 前缀，靠第二段 WAVE 区分）
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: "audio/wav", ext: ".wav", offset: 0, second: { bytes: [0x57, 0x41, 0x56, 0x45], offset: 8 } },
  // WebP：RIFF....WEBP
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: "image/webp", ext: ".webp", offset: 0, second: { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 } },
  { bytes: [0x4f, 0x67, 0x67, 0x53], mime: "audio/ogg", ext: ".ogg" },
  { bytes: [0x66, 0x4c, 0x61, 0x43], mime: "audio/flac", ext: ".flac" },
  // MP3：ID3 标签头 或 MPEG 帧同步 0xff 0xfb/0xf3/0xf2
  { bytes: [0x49, 0x44, 0x33], mime: "audio/mpeg", ext: ".mp3" },
  { bytes: [0xff, 0xfb], mime: "audio/mpeg", ext: ".mp3" },
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
    if (!match) continue;
    // 第二段精确匹配（如有）
    if (sig.second) {
      const s = sig.second;
      if (s.offset + s.bytes.length > buffer.length) continue;
      let match2 = true;
      for (let i = 0; i < s.bytes.length; i++) {
        if (buffer[s.offset + i] !== s.bytes[i]) {
          match2 = false;
          break;
        }
      }
      if (!match2) continue;
    }
    return { mime: sig.mime, ext: sig.ext };
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

/** 异步计算 Buffer SHA256（不阻塞事件循环） */
export async function computeBufferHash(buffer: Buffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Buffer.from(hashBuffer).toString("hex");
}
