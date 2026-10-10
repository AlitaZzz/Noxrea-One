import { bodyLimit } from "hono/body-limit";
import type { MiddlewareHandler } from "hono";

import { failCode } from "@server/core/response";
import { failBatchTooLarge, type UploadBatchLimits } from "@server/services/storage/upload-limits";

/** 受限请求体超过上限时由流包装器抛出，路由将其映射为结构化 413。 */
export class UploadBodyTooLargeError extends Error {
  constructor() {
    super("Upload request body exceeds the batch limit");
    this.name = "UploadBodyTooLargeError";
  }
}

export function jsonBodyLimit(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: () => failCode(413, "common.body_too_large"),
  });
}

/**
 * multipart 上传的 header 预检。它必须放在并发租约之前，避免已知超限请求占用队列。
 * 无长度的 chunked body 由 uploadBodyStreamLimit 在租约内边读边限流。
 */
export function uploadBodyLimit(limits: UploadBatchLimits): MiddlewareHandler {
  const maxBodyBytes = limits.maxBytes + 1024 * 1024;
  return async (c, next) => {
    const request = c.req.raw;
    const contentLength = request.headers.get("content-length");
    if (!request.headers.has("transfer-encoding") && contentLength !== null) {
      const length = Number(contentLength);
      if (Number.isFinite(length) && length > maxBodyBytes) return failBatchTooLarge();
    }
    return next();
  };
}

/**
 * 在并发租约内包装 chunked 请求体，超过上限的第一个 chunk 立即终止读取。
 * 不收集 chunks，避免 Hono bodyLimit 的完整缓冲；formData() 收到 sentinel 后由路由映射 413。
 */
export function uploadBodyStreamLimit(limits: UploadBatchLimits): MiddlewareHandler {
  const maxBodyBytes = limits.maxBytes + 1024 * 1024;
  return async (c, next) => {
    const body = c.req.raw.body;
    if (!body) return next();

    const reader = body.getReader();
    let size = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          size += value.byteLength;
          if (size > maxBodyBytes) {
            controller.error(new UploadBodyTooLargeError());
            await reader.cancel().catch(() => undefined);
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    c.req.raw = new Request(c.req.raw, { body: stream, duplex: "half" } as RequestInit & { duplex: "half" });
    return next();
  };
}
