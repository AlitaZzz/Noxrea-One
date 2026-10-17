/**
 * 上传格式白名单与准入判定（中转与直传共用的规则层）。
 * 独立于上传流程（upload.ts）：读路径（files 海报分支等）只需要规则本身，
 * 不应为此拉入上传流程的持久化/媒体依赖图。MIME 嗅探与扩展名工具在 mime.ts，XML 判定状态机在 xml-content.ts。
 */
import { extOfName, mimeByExt } from "./mime";

export const UPLOAD_FORMATS = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "avif"],
  video: ["mp4", "webm", "mov", "avi", "mkv"],
  audio: ["mp3", "wav", "ogg", "m4a", "aac", "flac", "webm"],
} as const;

export const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "image/avif",
  "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo",
  "video/x-matroska",
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg",
  "audio/flac", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/x-aac", "audio/webm",
]);

export const ALLOWED_EXT = new Set<string>(Object.values(UPLOAD_FORMATS).flat());

/** 视频扩展名判定（入参为含点扩展名，即 extOfName 产物；上传探测与 files 路由海报分支共用，口径派生自上传白名单单一来源） */
const VIDEO_EXT_RE = new RegExp(`\\.(?:${UPLOAD_FORMATS.video.join("|")})$`, "i");
export function isVideoExt(ext: string): boolean {
  return VIDEO_EXT_RE.test(ext);
}

/**
 * 上传准入判定（中转与直传票据/完成共用同一口径）：白名单内的客户端 MIME 或
 * 白名单内的名字扩展名任一命中即受理，另一侧信号仅作为元数据来源（回退推导）。
 * SVG 以任何信号申报（名字扩展名或客户端 MIME）一律拒绝——脚本风险，不支持；
 * 字节层 XML 拦截由各侧的复验承担（中转整份 Buffer / 直传流式状态机）。
 * 直传票据无字节可嗅探，两侧信号皆缺时只能在票据阶段 415 快速失败（结构性差异）。
 */
export interface UploadIdentity {
  /** 名字扩展名（含点、小写；无扩展名为空串） */
  nameExt: string;
  /** 白名单内的客户端 MIME（未提供或不在白名单为 null） */
  whitelistedMime: string | null;
  /** 名字扩展名在白名单内 */
  extOk: boolean;
  /** 名字扩展名或客户端 MIME 以 SVG 申报 */
  svg: boolean;
  /** 受理判定：白名单信号任一命中，且不以任何信号申报 SVG */
  admitted: boolean;
  /** 受理失败时的错误上下文展示值（客户端 MIME 优先，其次扩展名，兜底 unknown） */
  type: string;
}

export function evaluateUploadIdentity(name: string, contentType: string | undefined): UploadIdentity {
  const nameExt = extOfName(name);
  const whitelistedMime = contentType && ALLOWED_MIME.has(contentType) ? contentType : null;
  const extOk = nameExt !== "" && ALLOWED_EXT.has(nameExt.slice(1));
  const svg = nameExt === ".svg" || contentType === "image/svg+xml";
  return {
    nameExt,
    whitelistedMime,
    extOk,
    svg,
    admitted: !svg && (whitelistedMime !== null || extOk),
    type: contentType || nameExt || "unknown",
  };
}

/**
 * 上传 MIME 定档（中转与直传共用）：白名单客户端 MIME 优先，否则按扩展名 + 嗅探回退推导。
 * 门禁已由 evaluateUploadIdentity 完成，入参只收其判定结果；嗅探值由调用方提供
 * （中转扫整份 Buffer，直传取复验流前 16 字节）。
 */
export function resolveUploadMime(
  whitelistedMime: string | null,
  ext: string,
  sniffedMime: string,
): string {
  return whitelistedMime ?? mimeByExt(ext, sniffedMime);
}
