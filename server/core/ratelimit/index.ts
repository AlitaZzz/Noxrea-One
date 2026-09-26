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

/**
 * 通用具名限流器：同名（maxRequests, windowSeconds）全局唯一，惰性创建。
 * 各业务路由经 checkUserRateLimit 声明配额，无需为每个场景复制一个 getter。
 */
function getNamedRateLimiter(name: string, maxRequests: number, windowSeconds: number): RateLimiter {
  let limiter = globalLimiters.get(name);
  if (!limiter) {
    limiter = new RateLimiter(maxRequests, windowSeconds);
    globalLimiters.set(name, limiter);
  }
  return limiter;
}

/**
 * 已登录接口的按用户限流：以「业务名 + userId」为键。
 * 已登录请求的调用方身份明确，无需走 IP 解析（IP 维度留给未鉴权的登录/注册）。
 * 返回 false 表示被限流，调用方应回 429。
 */
export function checkUserRateLimit(
  name: string,
  userId: number,
  maxRequests: number,
  windowSeconds: number,
): boolean {
  return getNamedRateLimiter(name, maxRequests, windowSeconds).check(`${name}:${userId}`);
}
