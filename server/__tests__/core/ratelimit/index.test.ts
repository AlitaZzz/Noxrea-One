/**
 * 滑动窗口限流器：放行 / 超限拒绝 / Retry-After 秒数与窗口恢复
 * （specs/media-processing-concurrency.md 业务规则 5）。
 */
import { describe, expect, it, vi } from "vitest";

import { RateLimiter } from "@server/core/ratelimit";

describe("RateLimiter", () => {
  it("窗口内未超限时放行", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const limiter = new RateLimiter(2, 60);
      expect(limiter.check("k")).toEqual({ allowed: true });
      expect(limiter.check("k")).toEqual({ allowed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("超限拒绝并给出最早一次计数到期的剩余秒数（向上取整，至少 1）", () => {
    vi.useFakeTimers();
    try {
      const start = Date.parse("2026-01-01T00:00:00Z");
      vi.setSystemTime(start);
      const limiter = new RateLimiter(1, 60);
      limiter.check("k");

      // 30.5s 后第二次请求：最早计数还有 29.5s 到期 → 30s
      vi.setSystemTime(start + 30_500);
      expect(limiter.check("k")).toEqual({ allowed: false, retryAfterSeconds: 30 });

      // 59.9s：剩余 0.1s → 至少 1s
      vi.setSystemTime(start + 59_900);
      expect(limiter.check("k")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("按 key 独立计数，窗口滑过过期记录后恢复放行", () => {
    vi.useFakeTimers();
    try {
      const start = Date.parse("2026-01-01T00:00:00Z");
      vi.setSystemTime(start);
      const limiter = new RateLimiter(1, 60);
      expect(limiter.check("a").allowed).toBe(true);
      expect(limiter.check("b").allowed).toBe(true);
      expect(limiter.check("a").allowed).toBe(false);

      // 61s 后 a 的记录过期，重新放行
      vi.setSystemTime(start + 61_000);
      expect(limiter.check("a")).toEqual({ allowed: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
