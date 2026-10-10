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
  maxBatchFiles: number;
  maxBatchBytes: number;
  formats: UploadFormats;
}

const FALLBACK_UPLOAD_FORMATS: UploadFormats = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "avif"],
  video: ["mp4", "webm", "mov", "avi", "mkv"],
  audio: ["mp3", "wav", "ogg", "m4a", "aac", "flac", "webm"],
};

/**
 * 服务端限制未就绪时的兜底值（镜像当前默认配置，变更只应改服务端并同步此处）。
 * 与 FALLBACK_UPLOAD_FORMATS 同源：所有「服务端限制拿不到时」的代码都经过这里，
 * 不再各自散落半形状的兜底对象。
 */
export const FALLBACK_UPLOAD_LIMITS: UploadLimits = {
  maxSizeMb: 100,
  maxBatchFiles: 20,
  maxBatchBytes: 128 * 1024 * 1024,
  formats: FALLBACK_UPLOAD_FORMATS,
};

let cachedLimits: UploadLimits | null = null;

/**
 * loadUploadLimits 的在途 promise：并发调用（StrictMode 双挂载的启动预热 /
 * 弹窗打开）共享同一次请求。失败时清空以允许后续重试；成功后写入 cachedLimits。
 */
let limitsInFlight: Promise<UploadLimits> | null = null;

/** 同步读取当前白名单（未拉取到服务端数据时返回兜底值） */
export function getUploadFormats(): UploadFormats {
  return cachedLimits?.formats ?? FALLBACK_UPLOAD_FORMATS;
}

/**
 * 拉取并缓存服务端白名单；失败时抛出，由调用方决定兜底方式。
 * 成功后 getUploadFormats() 返回服务端数据。
 */
export function loadUploadLimits(): Promise<UploadLimits> {
  if (cachedLimits) return Promise.resolve(cachedLimits);
  limitsInFlight ??= api<UploadLimits>("/api/files/upload-limits")
    .then((limits) => {
      cachedLimits = limits;
      return limits;
    })
    .finally(() => {
      limitsInFlight = null;
    })
    .catch((err: unknown) => {
      // 兜底值会让本次上传按旧限制执行，留开发期日志便于发现配置端点故障
      if (process.env.NODE_ENV !== "production") {
        console.warn("[upload] 拉取 upload-limits 失败，使用兜底限制", err);
      }
      throw err;
    });
  return limitsInFlight;
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
  if (type === "image/svg+xml") return null;
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";

  if (!filename) return null;
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  return kindByExtension(filename.slice(dot + 1));
}
