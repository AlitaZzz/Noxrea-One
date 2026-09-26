/**
 * JSON 请求体体积上限中间件。
 *
 * Content-Length 可缺失或被 chunked 编码绕过，逐路由解析 body 无法约束体积；
 * hono bodyLimit 同时校验 header 与实际流字节数。分级上限统一在 app.ts 装配。
 */
import { bodyLimit } from "hono/body-limit";
import { failCode } from "@server/core/response";

export function jsonBodyLimit(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: () => failCode(413, "common.body_too_large"),
  });
}
