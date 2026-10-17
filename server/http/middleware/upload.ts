/**
 * 上传路由共享中间件（specs/storage-s3-backend.md 业务规则 6）：
 * requireUploadUser 认证并挂载 uploadUser；uploadConcurrencyLease 为中转上传、
 * 直传 ticket 与 complete 共用的按用户并发闸门——complete 承载提升 / 复验 / 探测
 * 的真实服务器成本；ticket 以排队上限约束 presign 滥用（租约瞬时，排队满即 429）。
 */
import type { MiddlewareHandler } from "hono";

import { GateRejectedError, waitForUserConcurrency } from "@server/core/ratelimit/concurrency";
import { failClientDisconnected, failCode } from "@server/core/response";
import { getSetting } from "@server/core/settings";
import { authenticateRequest, type AuthUser } from "@server/http/middleware/auth";

export type UploadEnv = {
  Variables: {
    uploadUser: AuthUser;
  };
};

/** 认证并挂载 uploadUser，供并发租约中间件与处理器读取 */
export const requireUploadUser: MiddlewareHandler<UploadEnv> = async (c, next) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  c.set("uploadUser", auth.user);
  return next();
};

export function uploadConcurrencyLease(): MiddlewareHandler<UploadEnv> {
  return async (c, next) => {
    const user = c.get("uploadUser");
    let release: (() => void) | undefined;
    try {
      release = await waitForUserConcurrency(
        "upload",
        user.id,
        getSetting("upload.batch_max_concurrent"),
        c.req.raw.signal,
        getSetting("upload.batch_max_pending"),
      );
    } catch (err) {
      // 按用户的门不设等待时限，过载只会是队列满：立即 429（客户端按可重试退避）；
      // 仅客户端断开按 499 收口；其他异常重新抛出
      if (err instanceof GateRejectedError) {
        return failCode(429, "upload.too_many_pending", undefined, {
          "Retry-After": "1",
          "Cache-Control": "no-store",
        });
      }
      if (!c.req.raw.signal.aborted) throw err;
      return failClientDisconnected("upload.cancelled");
    }
    try {
      return await next();
    } finally {
      release();
    }
  };
}
