/**
 * 限流拒绝响应：429 + Retry-After。
 * 登录 / 注册 / 生成 / 媒体编辑四个入口共用同一响应头形状，避免各自维护后漂移；
 * 禁止缓存由 `failCode` 对全部错误响应统一输出。
 */
import type { ErrorCode } from "@server/core/errors/codes";
import { failCode } from "@server/core/response";

export function failRateLimited(error: ErrorCode, retryAfterSeconds: number): Response {
  return failCode(429, error, undefined, {
    "Retry-After": String(retryAfterSeconds),
  });
}
