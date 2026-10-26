/**
 * 错误响应的缓存语义（specs/storage-signed-direct-delivery.md 规则 6.2）：
 * 非 2xx 一律 `no-store`，由 `failCode` 单点保证。
 *
 * 逐个调用点补头会漏——体积上限、全局 404、鉴权中间件都不经过业务路由，
 * 因此这条规则必须锁在构造点上。
 */
import { describe, expect, it } from "vitest";

import { failCode, failClientDisconnected } from "@server/core/response";

describe("failCode 的缓存头", () => {
  it("默认带 no-store，调用方无需逐个补", () => {
    for (const status of [401, 403, 404, 413, 429, 500, 503]) {
      const res = failCode(status, "common.internal_error");
      expect(res.status, String(status)).toBe(status);
      expect(res.headers.get("Cache-Control"), String(status)).toBe("no-store");
    }
  });

  it("调用方的业务头与 no-store 合并，不互相覆盖", () => {
    const res = failCode(429, "media.user_busy", undefined, { "Retry-After": "30" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("显式传入的 Cache-Control 可以覆盖默认值", () => {
    const res = failCode(404, "common.not_found", undefined, { "Cache-Control": "no-cache" });
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("客户端断开（499）同属错误响应，同样 no-store", () => {
    expect(failClientDisconnected("upload.cancelled").headers.get("Cache-Control")).toBe("no-store");
  });
});
