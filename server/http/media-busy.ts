/**
 * 媒体池过载响应：503 表示全站容量过载（可重试）；429 media.user_busy 表示
 * 该用户超出了自己的重型名额；429 common.rate_limited 表示请求次数超限。
 * 媒体路由与 `?w=` 缩略图共用。
 */

import { failCode } from "@server/core/response";
import {
  MEDIA_POOL_RETRY_AFTER_SECONDS,
  MEDIA_USER_BUSY_RETRY_AFTER_SECONDS,
  type MediaPoolName,
  type MediaPoolScope,
} from "@server/services/storage/media-pool";

export function failMediaBusy(pool: MediaPoolName, scope: MediaPoolScope): Response {
  if (scope === "user") {
    return failCode(429, "media.user_busy", undefined, {
      "Retry-After": String(MEDIA_USER_BUSY_RETRY_AFTER_SECONDS),
      "Cache-Control": "no-store",
    });
  }
  return failCode(503, "media.busy", undefined, {
    "Retry-After": String(MEDIA_POOL_RETRY_AFTER_SECONDS[pool]),
    "Cache-Control": "no-store",
  });
}
