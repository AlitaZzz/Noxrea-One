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

  // 类型限制
  const allowedTypes = [
    "image/jpeg", "image/png", "image/gif", "image/webp",
    "video/mp4", "video/webm",
    "audio/mpeg", "audio/wav", "audio/ogg", "audio/flac", "audio/mp4", "audio/x-m4a",
  ];
  if (file.type && !allowedTypes.includes(file.type)) {
    return failCode(415, "upload.unsupported_type", { type: file.type });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const hash = await computeBufferHash(buffer);
    const sniffed = sniffMime(buffer.subarray(0, 16));

    // 优先使用浏览器提供的 MIME（已通过白名单校验），sniffMime 仅作为 fallback
    // 避免 m4a 被嗅探为 video/mp4 等同签名格式的误判
    const mime = file.type || sniffed.mime;
    const finalExt = normalizeExt(file.type ? (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? sniffed.ext) : sniffed.ext);
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
