/**
 * 上传格式白名单的前端单源。
 *
 * 权威来源是服务端 /api/files/upload-limits（ALLOWED_FORMATS），
 * 应用启动时拉取并缓存；缓存未就绪的窗口内用 FALLBACK_UPLOAD_FORMATS 兜底
 * （镜像服务端当前白名单，格式变更只应改服务端并同步此处）。
 * 所有「按扩展名判定媒体类型 / 构造 accept」的代码都必须经过本模块，
 * 禁止再各自维护扩展名列表。
 */
import { api } from "@/lib/api/client";

export type MediaCategory = "image" | "video" | "audio";

export interface UploadFormats {
  image: string[];
  video: string[];
  audio: string[];
}

export interface UploadLimits {
  maxSizeMb: number;
  formats: UploadFormats;
}

const FALLBACK_UPLOAD_FORMATS: UploadFormats = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"],
  video: ["mp4", "webm", "mov", "avi", "mkv"],
  audio: ["mp3", "wav", "ogg", "m4a", "aac", "flac", "webm"],
};

let cachedLimits: UploadLimits | null = null;

/** 同步读取当前白名单（未拉取到服务端数据时返回兜底值） */
export function getUploadFormats(): UploadFormats {
  return cachedLimits?.formats ?? FALLBACK_UPLOAD_FORMATS;
}

/**
 * 拉取并缓存服务端白名单；失败时抛出，由调用方决定兜底方式。
 * 成功后 getUploadFormats() 返回服务端数据。
 */
export async function loadUploadLimits(signal?: AbortSignal): Promise<UploadLimits> {
  if (cachedLimits) return cachedLimits;
  cachedLimits = await api<UploadLimits>("/api/files/upload-limits", { signal });
  return cachedLimits;
}

/** 应用启动预热：失败时静默回落兜底值（上传校验仍由服务端把关） */
export async function loadUploadFormats(): Promise<UploadFormats> {
  try {
    return (await loadUploadLimits()).formats;
  } catch {
    return FALLBACK_UPLOAD_FORMATS;
  }
}

/** 按扩展名判定媒体类别；不在白名单内返回 null */
function kindByExtension(ext: string): MediaCategory | null {
  const e = ext.toLowerCase();
  const f = getUploadFormats();
  if (f.image.includes(e)) return "image";
  if (f.video.includes(e)) return "video";
  if (f.audio.includes(e)) return "audio";
  return null;
}

/** 判定 Blob 的媒体类别：优先 MIME，缺失时按文件名扩展名兜底 */
export function kindOfBlob(blob: { type: string }, filename?: string): MediaCategory | null {
  const type = blob.type;
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";

  if (!filename) return null;
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  return kindByExtension(filename.slice(dot + 1));
}
