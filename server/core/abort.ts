/**
 * 取消错误的统一构造。
 * AbortSignal.reason 可以是任意值（@hono/node-server 在客户端断开时传入的是字符串），
 * 原样抛出会让下游按 `name === "AbortError"` 的取消识别失效，把断开误判成处理失败。
 * 约定与 Node 核心 API 一致：错误名固定为 AbortError，原始 reason 放进 cause。
 */
export class AbortError extends Error {
  constructor(cause?: unknown) {
    super("The operation was aborted", { cause });
    this.name = "AbortError";
  }
}

/** signal 已中止时抛出 AbortError；替代会原样抛出 reason 的 signal.throwIfAborted() */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError(signal.reason);
}
