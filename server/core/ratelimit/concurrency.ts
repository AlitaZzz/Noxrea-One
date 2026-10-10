/**
 * 按用户的并发租约（信号量）。
 * 与滑动窗口限流（index.ts 的 RateLimiter）是两种独立机制：
 * 窗口限流拒绝超额请求，并发租约让超额请求 FIFO 排队等待槽位。
 */

interface ConcurrencyWaiter {
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  cleanup?: () => void;
}

/** 等待队列已满：调用方应回 429，让客户端按可重试退避，而不是让连接无限积压 */
export class ConcurrencyQueueFullError extends Error {
  constructor(maxPending: number) {
    super(`Concurrency queue full (maxPending=${maxPending})`);
    this.name = "ConcurrencyQueueFullError";
  }
}

/**
 * 单个用户的并发门：活动租约计数 + FIFO 等待队列。
 * 自持所属 Map 与槽位上限，清理与放行不再在调用方之间穿参。
 */
class UserGate {
  active = 0;
  readonly waiters: ConcurrencyWaiter[] = [];

  constructor(
    private readonly registry: Map<string, UserGate>,
    private readonly key: string,
    private readonly maxConcurrent: number,
  ) {}

  /** 已无活动租约且无排队者时从注册表移除自身，防止 Map 无限增长 */
  private cleanupIfIdle(): void {
    if (this.active === 0 && this.waiters.length === 0) this.registry.delete(this.key);
  }

  /** 依序放行队列中的等待者；已中止的直接拒绝，不占槽位 */
  private pump(): void {
    while (this.active < this.maxConcurrent && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.cleanup?.();
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason ?? new DOMException("The request was aborted", "AbortError"));
        continue;
      }

      this.active += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.pump();
        this.cleanupIfIdle();
      };
      waiter.resolve(release);
    }
    this.cleanupIfIdle();
  }

  /**
   * 等待并获取一个并发租约。
   * maxPending 封顶队列深度：超额立即拒绝（调用方回 429），防止单用户无限积压连接。
   */
  acquire(waiter: ConcurrencyWaiter, maxPending: number | undefined): void {
    if (waiter.signal?.aborted) {
      waiter.reject(waiter.signal.reason ?? new DOMException("The request was aborted", "AbortError"));
      this.cleanupIfIdle();
      return;
    }
    if (maxPending !== undefined && this.waiters.length >= maxPending) {
      waiter.reject(new ConcurrencyQueueFullError(maxPending));
      this.cleanupIfIdle();
      return;
    }
    const { signal } = waiter;
    const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
      if (index < 0) return;
      this.waiters.splice(index, 1);
      waiter.cleanup?.();
      waiter.reject(signal?.reason ?? new DOMException("The request was aborted", "AbortError"));
      this.cleanupIfIdle();
    };
    waiter.cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
    this.waiters.push(waiter);
    this.pump();
  }
}

const globalForConcurrency = globalThis as unknown as {
  __noxreaConcurrencyGates?: Map<string, Map<string, UserGate>>;
};

function getGateRegistry(): Map<string, Map<string, UserGate>> {
  const registry =
    globalForConcurrency.__noxreaConcurrencyGates ?? new Map<string, Map<string, UserGate>>();
  if (!globalForConcurrency.__noxreaConcurrencyGates) {
    globalForConcurrency.__noxreaConcurrencyGates = registry;
  }
  return registry;
}

/**
 * 等待并获取一个按用户计数的并发租约。
 * 租约必须由调用方在请求结束时释放；重复释放安全，不会产生负数计数。
 * 达到上限时请求进入该用户的 FIFO 队列，避免用固定 Retry-After 拒绝本可完成的批次。
 */
export async function waitForUserConcurrency(
  name: string,
  userId: number,
  maxConcurrent: number,
  signal?: AbortSignal,
  maxPending?: number,
): Promise<() => void> {
  const registry = getGateRegistry();

  let gates = registry.get(name);
  if (!gates) {
    gates = new Map<string, UserGate>();
    registry.set(name, gates);
  }

  // 注册表已按 name 分桶，内层键只需 userId
  const key = String(userId);
  const gate = gates.get(key) ?? new UserGate(gates, key, maxConcurrent);
  gates.set(key, gate);

  return new Promise<() => void>((resolve, reject) => {
    gate.acquire({ resolve, reject, signal }, maxPending);
  });
}
