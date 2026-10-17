/**
 * 直传路由（specs/storage-s3-backend.md 业务规则 6）：
 * ticket 签发预签名 PUT（含秒传短路），complete 服务端提升与复验。
 * 两端点均持用户并发租约：complete 承载提升 / 复验 / 探测的真实成本，
 * ticket 以排队上限约束 presign 滥用——与中转上传共用同一闸门。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { ZodType } from "zod";

import { logger } from "@server/core/logger";
import { failCode, ok } from "@server/core/response";
import { requireUploadUser, uploadConcurrencyLease, type UploadEnv } from "@server/http/middleware/upload";
import { uploadCompleteSchema, uploadTicketSchema } from "@server/schemas/storage";
import {
  completeDirectUpload,
  createUploadTicket,
  UploadDirectError,
} from "@server/services/storage/upload-direct";

const router = new Hono<UploadEnv>();

/** 直传错误映射：业务错误按携带的 status/code，未知错误记日志后 500 */
function failDirect(err: unknown): Response {
  if (err instanceof UploadDirectError) {
    return failCode(err.status, err.code, err.ctx);
  }
  logger.error({ err }, "Direct upload failed");
  return failCode(500, "upload.upload_failed");
}

/**
 * 直传端点共用骨架：JSON 解析 → schema 校验 → 服务调用，错误统一映射。
 * 两端点的差异只在 schema 与服务调用本身。
 */
function directHandler<T>(
  schema: ZodType<T>,
  run: (userId: number, data: T) => Promise<unknown>,
) {
  return async (c: Context<UploadEnv>) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return failCode(400, "common.invalid_json");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return failCode(422, "common.invalid_request");
    try {
      return c.json(ok(await run(c.get("uploadUser").id, parsed.data)));
    } catch (err) {
      return failDirect(err);
    }
  };
}

router.post(
  "/api/files/upload-ticket",
  requireUploadUser,
  uploadConcurrencyLease(),
  directHandler(uploadTicketSchema, (userId, data) =>
    createUploadTicket(userId, {
      hash: data.hash,
      size: data.size,
      name: data.name,
      contentType: data.content_type,
    }),
  ),
);

router.post(
  "/api/files/upload-complete",
  requireUploadUser,
  uploadConcurrencyLease(),
  directHandler(uploadCompleteSchema, (userId, data) =>
    completeDirectUpload(userId, {
      stagingKey: data.staging_key,
      hash: data.hash,
      name: data.name,
      contentType: data.content_type,
      source: data.source,
    }),
  ),
);

export { router };
