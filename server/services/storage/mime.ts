/**
 * MIME 知识单一来源。
 *
 * 扩展名 → MIME 主表（含 .wave/.oga/.opus 别名）与 magic bytes 嗅探表集中于此，
 * 上传定档、下载响应头、参考素材 data: URL、媒体产物落档共用。
 * 业务白名单（如 upload 的 ALLOWED_MIME / ALLOWED_FORMATS）属各路由策略，不在此处。
 */

/** 扩展名 → MIME 主表（键为小写含点形式） */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".wave": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};

/** 归一化扩展名（补点 + 小写） */
export function normalizeExt(ext: string): string {
  if (!ext.startsWith(".")) ext = "." + ext;
  return ext.toLowerCase();
}

/**
 * 按扩展名查 MIME。
 * 未收录时返回 fallback，各调用方按自己的语境传默认值
 * （如音频产物路由传 "audio/mpeg"、上传兜底传嗅探结果）。
 */
export function mimeByExt(ext: string, fallback = "application/octet-stream"): string {
  return MIME_BY_EXT[normalizeExt(ext)] ?? fallback;
}

/** magic bytes 签名表（支持两段匹配：first + 可选 second / brand 细分） */
interface MagicSignature {
  bytes: number[];
  mime: string;
  ext: string;
  offset?: number;
  /** 第二段精确匹配，用于区分共享同一前缀的格式（如 RIFF→WAVE/WEBP） */
  second?: { bytes: number[]; offset: number };
  /** ftyp major brand（位于 offset 8）→ 变体判定；未命中品牌用本条默认值 */
  brands?: Record<string, { mime: string; ext: string }>;
}

const MAGIC_SIGNATURES: MagicSignature[] = [
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg", ext: ".jpg" },
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: "image/png", ext: ".png" },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: "image/gif", ext: ".gif" },
  // WAV：RIFF....WAVE（与 webp 同为 RIFF 前缀，靠第二段 WAVE 区分）
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: "audio/wav", ext: ".wav", offset: 0, second: { bytes: [0x57, 0x41, 0x56, 0x45], offset: 8 } },
  // WebP：RIFF....WEBP
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: "image/webp", ext: ".webp", offset: 0, second: { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 } },
  { bytes: [0x4f, 0x67, 0x67, 0x53], mime: "audio/ogg", ext: ".ogg" },
  { bytes: [0x66, 0x4c, 0x61, 0x43], mime: "audio/flac", ext: ".flac" },
  // MP3：ID3 标签头 或 MPEG 帧同步 0xff 0xfb
  { bytes: [0x49, 0x44, 0x33], mime: "audio/mpeg", ext: ".mp3" },
  { bytes: [0xff, 0xfb], mime: "audio/mpeg", ext: ".mp3" },
  // MP4 系容器：ftyp 按 major brand 细分——M4A 为音频
  // （此前一律判 video/mp4，导致 m4a 被存成 .mp4）
  {
    bytes: [0x66, 0x74, 0x79, 0x70],
    mime: "video/mp4",
    ext: ".mp4",
    offset: 4,
    brands: { "M4A ": { mime: "audio/mp4", ext: ".m4a" } },
  },
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
    // ftyp major brand 细分（如有）
    if (sig.brands) {
      const brandOffset = start + 4;
      if (brandOffset + 4 <= buffer.length) {
        const brand = buffer.toString("latin1", brandOffset, brandOffset + 4);
        const variant = sig.brands[brand];
        if (variant) return { mime: variant.mime, ext: variant.ext };
      }
    }
    return { mime: sig.mime, ext: sig.ext };
  }
  return { mime: "application/octet-stream", ext: ".bin" };
}
