/**
 * 内存限流器。
 * 基于滑动窗口实现按标识的速率限制，防止接口被过度调用。
 */

interface WindowEntry {
  timestamps: number[];
}

const globalForRateLimit = globalThis as unknown as {
  __noxreaRateLimiters?: Map<string, RateLimiter>;
};

export class RateLimiter {
  private windows = new Map<string, WindowEntry>();
  private maxRequests: number;
  private windowSeconds: number;
  private lastCleanup = Date.now();

  constructor(maxRequests: number, windowSeconds: number) {
    this.maxRequests = maxRequests;
    this.windowSeconds = windowSeconds;
  }

  /**
   * 检查是否允许通过。
   * 返回 true 表示放行，false 表示被限流。
   */
  check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowSeconds * 1000;

    // 定期清理空条目，防止内存泄漏
    if (now - this.lastCleanup > this.windowSeconds * 1000 * 2) {
      for (const [k, entry] of this.windows) {
        entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
        if (entry.timestamps.length === 0) {
          this.windows.delete(k);
        }
      }
      this.lastCleanup = now;
    }

    let entry = this.windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }

    // 清理过期时间戳
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    // 检查是否超限
    if (entry.timestamps.length >= this.maxRequests) {
      return false;
    }

    // 记录本次请求
    entry.timestamps.push(now);
    return true;
  }

  /** 获取剩余配额 */
  remaining(key: string): number {
    const now = Date.now();
    const cutoff = now - this.windowSeconds * 1000;

    const entry = this.windows.get(key);
    if (!entry) return this.maxRequests;

    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    return Math.max(0, this.maxRequests - entry.timestamps.length);
  }
}

// 预置限流器

const globalLimiters =
  globalForRateLimit.__noxreaRateLimiters ?? new Map();

if (!globalForRateLimit.__noxreaRateLimiters) {
  globalForRateLimit.__noxreaRateLimiters = globalLimiters;
}

/** 登录限流：每分钟 5 次 */
export function getLoginRateLimiter(): RateLimiter {
  const key = "login";
  let limiter = globalLimiters.get(key);
  if (!limiter) {
    limiter = new RateLimiter(5, 60);
    globalLimiters.set(key, limiter);
  }
  return limiter;
}

/** 注册限流：每小时 3 次 */
export function getRegisterRateLimiter(): RateLimiter {
  const key = "register";
  let limiter = globalLimiters.get(key);
  if (!limiter) {
    limiter = new RateLimiter(3, 3600);
    globalLimiters.set(key, limiter);
  }
  return limiter;
}
