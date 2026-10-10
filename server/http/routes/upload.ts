/** 文件上传路由：认证、请求体预检、并发租约、multipart 解析和批次约束。 */
import { Hono } from "hono";

import { getConfig } from "@server/core/config";
import { ConcurrencyQueueFullError, waitForUserConcurrency } from "@server/core/ratelimit/concurrency";
import { failCode, failClientDisconnected, ok } from "@server/core/response";
import { authenticateRequest, type AuthUser } from "@server/http/middleware/auth";
import { uploadBodyLimit, uploadBodyStreamLimit, UploadBodyTooLargeError } from "@server/http/middleware/body-limit";
import { failBatchTooLarge, getUploadBatchLimits } from "@server/services/storage/upload-limits";
import { processUploadBatch, UPLOAD_FORMATS } from "@server/services/storage/upload";

type UploadEnv = {
  Variables: {
    uploadUser: AuthUser;
  };
};

const router = new Hono<UploadEnv>();

/** 上传约束：供前端批次调度和格式提示共用，避免两端漂移。 */
router.get("/api/files/upload-limits", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;

  const limits = getUploadBatchLimits();
  return c.json(ok({
    maxSizeMb: getConfig().MAX_UPLOAD_SIZE_MB,
    maxBatchFiles: limits.maxFiles,
    maxBatchBytes: limits.maxBytes,
    formats: UPLOAD_FORMATS,
  }));
});

router.post(
  "/api/files/upload",
  async (c, next) => {
    const auth = await authenticateRequest(c.req.raw);
    if ("error" in auth) return auth.error;
    c.set("uploadUser", auth.user);
    return next();
  },
  // 请求体 header 预检先于并发租约；chunked 请求在租约内通过流式 middleware 限制
  uploadBodyLimit(getUploadBatchLimits()),
  async (c, next) => {
    const user = c.get("uploadUser");
    let release: (() => void) | undefined;
    try {
      const cfg = getConfig();
      release = await waitForUserConcurrency(
        "upload",
        user.id,
        cfg.UPLOAD_BATCH_MAX_CONCURRENT,
        c.req.raw.signal,
        cfg.UPLOAD_BATCH_MAX_PENDING,
      );
    } catch (err) {
      // 队列满立即 429（客户端按可重试退避）；仅客户端断开按 499 收口；其他异常重新抛出
      if (err instanceof ConcurrencyQueueFullError) {
        return failCode(429, "upload.too_many_pending", undefined, { "Retry-After": "1" });
      }
      if (!c.req.raw.signal.aborted) throw err;
      return failClientDisconnected("upload.cancelled");
    }
    try {
      return await next();
    } finally {
      release();
    }
  },
  uploadBodyStreamLimit(getUploadBatchLimits()),
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
