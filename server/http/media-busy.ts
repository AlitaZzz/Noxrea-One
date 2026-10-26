/**
 * 媒体池过载响应：503 表示全站容量过载（可重试）；429 media.user_busy 表示
 * 该用户超出了自己的重型名额；429 common.rate_limited 表示请求次数超限。
 * 媒体路由与 `?w=` 缩略图共用。
 *
 * 指标不在这里记：过载拒绝有「整响应」与「逐条错误码」两种出口（描述接口只给
 * 错误码），计数统一发生在捕获 `MediaPoolBusyError` 的分类点，避免只覆盖其中一种。
 */

import { failCode } from "@server/core/response";
import {
  MEDIA_POOL_RETRY_AFTER_SECONDS,
  MEDIA_USER_BUSY_RETRY_AFTER_SECONDS,
  type MediaPoolName,
  type MediaPoolScope,
} from "@server/services/storage/media-pool";

/**
 * 过载阶段 → 错误码（单一来源）：整响应路径与逐条错误码路径都从这里取值，
 * 新增阶段只改这一处，两条出口不会分叉。
 */
export function mediaBusyCode(scope: MediaPoolScope): "media.user_busy" | "media.busy" {
  return scope === "user" ? "media.user_busy" : "media.busy";
}

export function failMediaBusy(pool: MediaPoolName, scope: MediaPoolScope): Response {
  // no-store 由 failCode 统一输出；这里只补过载特有的 Retry-After
  if (scope === "user") {
    return failCode(429, mediaBusyCode(scope), undefined, {
      "Retry-After": String(MEDIA_USER_BUSY_RETRY_AFTER_SECONDS),
    });
  }
  return failCode(503, mediaBusyCode(scope), undefined, {
    "Retry-After": String(MEDIA_POOL_RETRY_AFTER_SECONDS[pool]),
  });
}
