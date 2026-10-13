/**
 * 有界并发门。
 * 两种使用形态共用同一 BoundedGate 实现：
 * - 按用户并发租约（waitForUserConcurrency）：FIFO 排队 + 队列深度上限，无等待时限；
 * - 媒体处理全局池（media-pool.ts）：FIFO 排队 + 队列深度上限 + 等待时限 + AbortSignal 出队。
 */

import { AbortError } from "@server/core/abort";

export type GateRejectionReason = "queue_full" | "wait_timeout";

/** 过载拒绝：队列已满（立即拒绝）或排队超过等待时限，两种情况都未启动任何处理 */
export class GateRejectedError extends Error {
  constructor(
    public readonly reason: GateRejectionReason,
    /** 门名与 limit 只用于错误消息 */
    gate: string,
    /** queue_full 为队列深度上限，wait_timeout 为等待时限（毫秒） */
    limit: number,
  ) {
    super(
      reason === "queue_full"
        ? `Gate "${gate}" queue full (maxPending=${limit})`
        : `Gate "${gate}" wait timed out (maxWaitMs=${limit})`,
    );
    this.name = "GateRejectedError";
  }
}

interface GateWaiter {
  resolve: (release: () => void) => void;
  signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

/**
 * 有界 FIFO 并发门：活动槽位计数 + 等待队列。
 * acquire 支持队列深度上限（超额立即拒绝）、等待时限（超时出队并拒绝）与
 * AbortSignal（排队期间触发即出队，不占槽位）。释放幂等，重复调用无副作用。
 */
export class BoundedGate {
  private active = 0;
  private readonly waiters: GateWaiter[] = [];

  constructor(
    private readonly name: string,
    private readonly maxConcurrent: number,
  ) {}

  /** 创建时固定的槽位上限 */
  get capacity(): number {
    return this.maxConcurrent;
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.waiters.length;
  }

  /** 摘除等待者挂载的定时器与中止监听 */
  private detach(waiter: GateWaiter): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  /** 把仍在排队的等待者移出队列；已被放行（不在队列）返回 false */
  private dequeue(waiter: GateWaiter): boolean {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return false;
    this.waiters.splice(index, 1);
    this.detach(waiter);
    return true;
  }

  /**
   * 依序放行队列中的等待者。排队者的 signal 一旦中止，监听器会同步将其出队，
   * 因此队列里不会出现已中止的等待者，这里无需再判断。
   */
  private pump(): void {
    while (this.active < this.maxConcurrent && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      this.detach(waiter);
      this.active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.pump();
      });
    }
  }

  acquire(
    opts: { signal?: AbortSignal; maxPending?: number; maxWaitMs?: number } = {},
  ): Promise<() => void> {
    const { signal, maxPending, maxWaitMs } = opts;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortError(signal.reason));
        return;
      }
      // 队列深度只约束等待者：有空闲槽位时直接放行，maxPending=0 表示「满即拒」
      if (this.active >= this.maxConcurrent && maxPending !== undefined && this.waiters.length >= maxPending) {
        reject(new GateRejectedError("queue_full", this.name, maxPending));
        return;
      }

      const waiter: GateWaiter = { resolve, signal };
      if (maxWaitMs !== undefined) {
        waiter.timer = setTimeout(() => {
          if (this.dequeue(waiter)) reject(new GateRejectedError("wait_timeout", this.name, maxWaitMs));
        }, maxWaitMs);
      }
      if (signal) {
        waiter.onAbort = () => {
          if (this.dequeue(waiter)) reject(new AbortError(signal.reason));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.pump();
    });
  }
}

/**
 * 单个用户的并发门：BoundedGate + 空闲时从所属注册表移除自身，
 * 防止注册表随用户数无限增长。
 */
class UserGate {
  private readonly gate: BoundedGate;

  constructor(
    private readonly registry: Map<string, UserGate>,
    private readonly key: string,
    maxConcurrent: number,
  ) {
    this.gate = new BoundedGate(`user:${key}`, maxConcurrent);
  }

  private cleanupIfIdle(): void {
    if (this.gate.activeCount === 0 && this.gate.pendingCount === 0) this.registry.delete(this.key);
  }

  stats(): { active: number; pending: number } {
    return { active: this.gate.activeCount, pending: this.gate.pendingCount };
  }

  async acquire(opts: { signal?: AbortSignal; maxPending?: number; maxWaitMs?: number } = {}): Promise<() => void> {
    try {
      const release = await this.gate.acquire(opts);
      // 释放连同空闲清理只执行一次：重复调用若再清理一次，会把同一用户随后新建的门从注册表删掉
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
        this.cleanupIfIdle();
      };
    } catch (err) {
      this.cleanupIfIdle();
      throw err;
    }
  }
}

/** name → userId → 该用户的并发门 */
const gateRegistry = new Map<string, Map<string, UserGate>>();

/** 读取某用户当前门的活动数与等待数（过载日志的可观测性用）；该用户无门时返回 undefined */
export function getUserGateCounts(
  name: string,
  userId: number,
): { active: number; pending: number } | undefined {
  return gateRegistry.get(name)?.get(String(userId))?.stats();
}

/**
 * 等待并获取一个按用户计数的并发租约。
 * 租约必须由调用方在请求结束时释放；重复释放安全，不会产生负数计数。
 * 达到上限时请求进入该用户的 FIFO 队列，避免用固定 Retry-After 拒绝本可完成的批次；
 * 队列深度超过 maxPending 抛 GateRejectedError（调用方回 429），
 * 排队超过 maxWaitMs 同样出队拒绝（媒体池个人阶段使用，见 media-pool.ts）。
 */
export async function waitForUserConcurrency(
  name: string,
  userId: number,
  maxConcurrent: number,
  signal?: AbortSignal,
  maxPending?: number,
  maxWaitMs?: number,
): Promise<() => void> {
  let gates = gateRegistry.get(name);
  if (!gates) {
    gates = new Map<string, UserGate>();
    gateRegistry.set(name, gates);
  }

  // 注册表已按 name 分桶，内层键只需 userId
  const key = String(userId);
  const gate = gates.get(key) ?? new UserGate(gates, key, maxConcurrent);
  gates.set(key, gate);

  return gate.acquire({ signal, maxPending, maxWaitMs });
}
