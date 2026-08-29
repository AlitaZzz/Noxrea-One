/**
 * 请求 ID 中间件。
 * 为每个请求分配唯一标识：注入异步上下文（供日志与错误响应使用）并写入响应头。
 * 客户端可通过 X-Request-Id 传入自有标识以便跨系统串联。
 */
import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";
import { runWithRequestContext } from "@server/core/logger/context";

/** 请求 ID 使用的请求头/响应头名称 */
export const REQUEST_ID_HEADER = "X-Request-Id";

/** 允许的客户端请求 ID 字符集，避免换行等字符污染日志 */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** 生成 12 位十六进制请求 ID */
function createRequestId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * 请求 ID 中间件工厂。
 * 在 next() 之后再写入响应头，确保对直接返回 Response 的 handler 同样生效。
 */
export function requestId(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER)?.trim();
    const id =
      incoming && SAFE_ID_RE.test(incoming) ? incoming : createRequestId();

    await runWithRequestContext({ requestId: id }, next);

    c.res.headers.set(REQUEST_ID_HEADER, id);
  };
}
