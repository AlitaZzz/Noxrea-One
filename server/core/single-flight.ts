/**
 * 同键请求合并（single-flight）：同一键的并发请求只执行一次生成，其余请求等待同一结果。
 * 中止按引用计数——全部等待者都已中止才取消生成，先到的请求断开不影响搭车者；
 * 成败（含媒体池过载等业务错误）由全体等待者共享，条目随即移除，不做负缓存。
 *
 * 与具体领域无关：存储派生、媒体探测与鉴权快照回源共用同一实现。
 */

import { AbortError } from "@server/core/abort";

const inflight = new Map<string, Flight<unknown>>();

/** 一次在途生成，以等待者引用计数管理取消 */
class Flight<T> {
  readonly promise: Promise<T>;
  private waiters = 1;
  private readonly controller = new AbortController();

  constructor(private readonly key: string, generate: (signal: AbortSignal) => Promise<T>) {
    this.promise = generate(this.controller.signal).finally(() => this.unregister());
  }

  join(): void {
    this.waiters += 1;
  }

  /**
   * 等待者退出。最后一个退出时先从在途表摘除再取消生成：之后到达的同键请求
   * 会发起新的生成，而不是加入一个正在中止的生成并收到与自身无关的 AbortError。
   */
  leave(): void {
    this.waiters -= 1;
    if (this.waiters > 0) return;
    this.unregister();
    this.controller.abort();
  }

  private unregister(): void {
    if (inflight.get(this.key) === this) inflight.delete(this.key);
  }
}

interface SingleFlightOptions<T> {
  key: string;
  signal?: AbortSignal;
  /** 真正的生成动作；signal 在「全部等待者均已中止」时触发 */
  generate: (signal: AbortSignal) => Promise<T>;
}

export function runSingleFlight<T>({ key, signal, generate }: SingleFlightOptions<T>): Promise<T> {
  if (signal?.aborted) return Promise.reject(new AbortError(signal.reason));

  let flight = inflight.get(key) as Flight<T> | undefined;
  if (flight) {
    flight.join();
  } else {
    flight = new Flight(key, generate);
    inflight.set(key, flight);
  }
  return awaitFlight(flight, signal);
}

/** 等待在途生成；自身中止只退出等待（引用计数减一），不影响生成与其他等待者 */
function awaitFlight<T>(flight: Flight<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      flight.leave();
      reject(new AbortError(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const detach = () => signal?.removeEventListener("abort", onAbort);
    flight.promise.then(
      (value) => {
        detach();
        resolve(value);
      },
      (err: unknown) => {
        detach();
        reject(err);
      },
    );
  });
}
