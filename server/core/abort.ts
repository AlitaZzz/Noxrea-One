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

/** 是否为取消错误：core AbortError 与运行时 DOMException 同名，按 name 统一识别 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * 媒体工具或截帧预算的超时。
 * 调用方按类型或 name 判定超时，不嗅探错误消息：消息属于诊断文本，改措辞
 * 不应改变 HTTP 状态映射。
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * 是否为超时错误。
 * 外部库同样以 name = "TimeoutError" 标识超时（@smithy/node-http-handler 的
 * socket/connection timeout、HttpTimeoutError、DOMException），只认本模块的类
 * 会让 S3 下载等既有超时来源在路由层退化成 500。
 */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}
