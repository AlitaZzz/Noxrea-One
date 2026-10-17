/** 文件上传路由：认证、请求体预检、并发租约、multipart 解析和批次约束。 */
import { Hono } from "hono";

import { getSetting } from "@server/core/settings";
import { failCode, ok } from "@server/core/response";
import { requireUploadUser, uploadConcurrencyLease, type UploadEnv } from "@server/http/middleware/upload";
import { uploadBodyLimit, uploadBodyStreamLimit, UploadBodyTooLargeError } from "@server/http/middleware/body-limit";
import { failBatchTooLarge, getUploadBatchLimits } from "@server/services/storage/upload-limits";
import { getStorageBackend } from "@server/services/storage/service";
import { supportsDirectUpload } from "@server/services/storage/backend";
import { UPLOAD_FORMATS } from "@server/services/storage/formats";
import { processUploadBatch } from "@server/services/storage/upload";

const router = new Hono<UploadEnv>();

/** 上传约束：供前端批次调度和格式提示共用，避免两端漂移。 */
router.get("/api/files/upload-limits", requireUploadUser, async (c) => {
  const limits = getUploadBatchLimits();
  return c.json(ok({
    maxSizeMb: getSetting("upload.max_file_mb"),
    maxBatchFiles: limits.maxFiles,
    maxBatchBytes: limits.maxBytes,
    formats: UPLOAD_FORMATS,
    // 直传能力统一判定（与 ticket/complete 同口径）：前端据此选择直传或中转路径
    mode: supportsDirectUpload(getStorageBackend()) ? "direct" : "relay",
  }));
});

router.post(
  "/api/files/upload",
  requireUploadUser,
  // 请求体 header 预检先于并发租约；chunked 请求在租约内通过流式 middleware 限制
  uploadBodyLimit(),
  uploadConcurrencyLease(),
  uploadBodyStreamLimit(),
  async (c) => {
    const user = c.get("uploadUser");

    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch (err) {
      if (err instanceof UploadBodyTooLargeError) return failBatchTooLarge();
      return failCode(400, "upload.invalid_form_data");
    }

    const entries = formData.getAll("file");
    const files = entries.filter((entry): entry is File => entry instanceof File);
    if (entries.length !== files.length) return failCode(400, "upload.invalid_form_data");
    if (files.length === 0) return failCode(400, "upload.no_file");

    const limits = getUploadBatchLimits();
    if (files.length > limits.maxFiles) return failBatchTooLarge();

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > limits.maxBytes) return failBatchTooLarge();

    const source = c.req.query("source") === "derived" ? "derived" : "upload";
    const result = await processUploadBatch(files, user.id, source);
    return c.json(ok(result));
  },
);

export { router };
