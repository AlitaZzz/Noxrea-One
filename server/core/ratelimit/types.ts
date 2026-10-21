/** 一组限流额度：窗口内最大请求数与窗口长度（秒）。 */
export interface RateLimitQuota {
  readonly maxRequests: number;
  readonly windowSeconds: number;
}

/** 限流结果：超限时必定携带窗口内最早计数到期的剩余秒数（向上取整，至少 1）。 */
export type RateLimitResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/** 限流计数存储：生产为 Redis，多副本共享；测试可注入内存替身。 */
export interface RateLimitStore {
  check(key: string, quota: RateLimitQuota): Promise<RateLimitResult>;
  close(): Promise<void>;
}
