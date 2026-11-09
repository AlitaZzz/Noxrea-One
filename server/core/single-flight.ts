/**
 * 同键请求合并（single-flight）：同一键的并发请求只执行一次生成，其余请求等待同一结果。
 * 中止按引用计数——全部等待者都已中止才取消生成，先到的请求断开不影响搭车者；
 * 成败（含媒体池过载等业务错误）由全体等待者共享，条目随即移除，不做负缓存。
 *
 * 创建者的输入可能被在途生成持续读取（典型是 S3 源租约按请求下载的临时路径）。
 * 创建者中止时不能立刻结束其请求处理——那会在 finally 里释放租约、删掉生成仍在
 * 读的文件；因此创建者的等待推迟到生成结算后才以 AbortError 结束，而未创建在途
 * 条目的等待者仍立即退出。生成本身在还有搭车者时继续，语义不变。
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

export interface SingleFlightOptions<T> {
  key: string;
  signal?: AbortSignal;
  /** 真正的生成动作；signal 在「全部等待者均已中止」时触发 */
  generate: (signal: AbortSignal) => Promise<T>;
}

export function runSingleFlight<T>({ key, signal, generate }: SingleFlightOptions<T>): Promise<T> {
  if (signal?.aborted) return Promise.reject(new AbortError(signal.reason));

  let flight = inflight.get(key) as Flight<T> | undefined;
  const isOwner = !flight;
  if (flight) {
    flight.join();
  } else {
    flight = new Flight(key, generate);
    inflight.set(key, flight);
  }
  return awaitFlight(flight, signal, isOwner);
}

/**
 * 等待在途生成；自身中止只退出等待（引用计数减一），不影响生成与其他等待者。
 *
 * 创建者在生成结算前不结束等待：其 finally 会释放生成正在读取的输入。搭车者
 * 中止时其输入不参与生成，可以立即结束。生成结算后创建者以 AbortError 结束，
 * 不会把结果交给已中止的请求。
 */
function awaitFlight<T>(flight: Flight<T>, signal: AbortSignal | undefined, isOwner: boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let aborted = false;
    let abortError: AbortError | undefined;
    const detach = () => signal?.removeEventListener("abort", onAbort);
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      detach();
      fn();
    };
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      abortError = new AbortError(signal?.reason);
      flight.leave();
      // 创建者等到生成结算再退出，租约等输入在生成期间保持可用
      if (!isOwner) finish(() => reject(abortError));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    flight.promise.then(
      (value) => finish(() => (aborted ? reject(abortError) : resolve(value))),
      (err: unknown) => finish(() => reject(aborted ? abortError : err)),
    );
  });
}
