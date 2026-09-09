/**
 * 文件上传路由。
 * 处理 multipart 文件上传，完成哈希校验、落盘与文件对象持久化。
 */
import { Hono } from "hono";
import { authenticateRequest } from "@server/core/auth/middleware";
import { getConfig } from "@server/core/config";
import { computeBufferHash, sniffMime, normalizeExt } from "@server/services/storage/hash";
import { buildStorageKey } from "@server/services/storage/service";
import { persistFileObject } from "@server/services/storage/persist";
import { localStorage } from "@server/services/storage/backends/local";
import { ok, failCode } from "@server/core/response";
import { logger } from "@server/core/logger";

const router = new Hono();

/**
 * 允许的 MIME 白名单。
 * 与前端 detectMediaKind 支持的格式对齐：浏览器对 mkv / mov / avi 等容器
 * 上报的 MIME 并不统一（x-matroska、quicktime、x-msvideo…），必须一并放开。
 */
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "image/bmp", "image/x-ms-bmp", "image/svg+xml", "image/avif",
  "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo",
  "video/x-matroska", "video/x-m4v", "video/mpeg",
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg",
  "audio/flac", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/x-aac", "audio/webm",
]);

/** 允许的扩展名白名单：MIME 缺失或不常见时（如 mkv 被上报为 octet-stream）按扩展名兜底 */
const ALLOWED_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif",
  "mp4", "webm", "mov", "avi", "mkv", "m4v", "mpg", "mpeg",
  "mp3", "wav", "ogg", "m4a", "aac", "flac",
]);

/** 扩展名 → MIME：浏览器未提供 MIME 时据此定档，避免 mkv / m4a 落库成 octet-stream */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".m4v": "video/x-m4v",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};

/** 取文件名后缀（含点，小写）；无后缀返回空串 */
function extOfName(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? `.${m[1].toLowerCase()}` : "";
}

router.post("/api/files/upload", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const cfg = getConfig();
  const maxSize = cfg.MAX_UPLOAD_SIZE_MB * 1024 * 1024;

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return failCode(400, "upload.invalid_form_data");
  }

  const file = formData.get("file") as File | null;
  if (!file) return failCode(400, "upload.no_file");

  // 体积限制
  if (file.size > maxSize) {
    return failCode(413, "upload.file_too_large", { limit: cfg.MAX_UPLOAD_SIZE_MB });
  }

  // 类型限制：MIME 与扩展名任一命中白名单即放行。
  // 仅按 MIME 判定会误杀 mkv / mov 等容器（各浏览器上报不一致，甚至为 octet-stream），
  // 仅按扩展名判定又会让伪造后缀的文件蒙混过关，故两者取「或」。
  const nameExt = extOfName(file.name);
  const mimeOk = Boolean(file.type) && ALLOWED_MIME.has(file.type);
  const extOk = nameExt !== "" && ALLOWED_EXT.has(nameExt.slice(1));
  if (!mimeOk && !extOk) {
    return failCode(415, "upload.unsupported_type", { type: file.type || nameExt || "unknown" });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const hash = await computeBufferHash(buffer);
    const sniffed = sniffMime(buffer.subarray(0, 16));

    // 优先使用浏览器提供的 MIME（已通过白名单校验），其次按扩展名定档，
    // sniffMime 仅作兜底——避免 m4a 被嗅探为 video/mp4 等同签名格式的误判
    const mime = (file.type && mimeOk ? file.type : null) ?? MIME_BY_EXT[nameExt] ?? sniffed.mime;
    // 扩展名同理：白名单内的后缀优先，避免 mkv 这类嗅探不出的容器被存成 .bin
    const finalExt = extOk ? nameExt : normalizeExt(sniffed.ext);
    const storageKey = buildStorageKey(auth.user.id, hash, finalExt);

    // 写入本地
    await localStorage.save(storageKey, buffer);

    // 持久化
    const source = (c.req.query("source") as "upload" | "derived") || "upload";
    await persistFileObject({
      userId: auth.user.id,
      hash,
      size: buffer.length,
      mimeType: mime,
      ext: finalExt,
      source,
    });

    return c.json(
      ok({
        key: storageKey,
        url: `/api/files/${storageKey}`,
        size: buffer.length,
        mime_type: mime,
        hash,
      })
    );
  } catch (err: unknown) {
    // 落盘/持久化的底层异常只进日志，不随响应下发
    logger.error({ err }, "Upload failed");
    return failCode(500, "upload.upload_failed");
  }
});

export { router };
