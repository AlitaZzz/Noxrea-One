import { Hono } from "hono";
import { authenticateRequest } from "@server/core/auth/middleware";
import { getConfig } from "@server/core/config";
import { computeBufferHash, sniffMime, normalizeExt } from "@server/services/storage/hash";
import { buildStorageKey } from "@server/services/storage/service";
import { persistFileObject } from "@server/services/storage/persist";
import { localStorage } from "@server/services/storage/backends/local";
import { ok, fail } from "@server/core/response";

const router = new Hono();

// ── POST /api/files/upload (multipart/formdata) ──
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
    return fail(400, "Invalid form data");
  }

  const file = formData.get("file") as File | null;
  if (!file) return fail(400, "No file provided");

  // 体积限制
  if (file.size > maxSize) {
    return fail(413, `File size exceeds limit of ${cfg.MAX_UPLOAD_SIZE_MB}MB`);
  }

  // 类型限制
  const allowedTypes = [
    "image/jpeg", "image/png", "image/gif", "image/webp",
    "video/mp4", "video/webm",
    "audio/mpeg", "audio/wav", "audio/ogg", "audio/flac",
  ];
  if (file.type && !allowedTypes.includes(file.type)) {
    return fail(415, `Unsupported file type: ${file.type}`);
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const hash = computeBufferHash(buffer);
    const { mime, ext } = sniffMime(buffer.slice(0, 16));

    const finalExt = normalizeExt(ext);
    const storageKey = buildStorageKey(auth.user.id, hash, finalExt);

    // 写入本地
    await localStorage.save(storageKey, buffer);

    // 持久化
    await persistFileObject({
      userId: auth.user.id,
      hash,
      size: buffer.length,
      mimeType: mime,
      ext: finalExt,
      source: "upload",
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
    return fail(500, (err as Error).message ?? "Upload failed");
  }
});

export { router };
