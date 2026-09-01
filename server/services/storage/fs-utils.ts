/**
 * 文件系统瞬时错误处理。
 *
 * Windows 下文件被外部句柄短暂占用时（sharp/libvips 的 native 句柄、
 * 安全软件实时扫描、索引服务），libuv 常常抛出一个**未被映射**的错误：
 *
 *   { errno: -4094, code: "UNKNOWN", syscall: "open" }
 *
 * 它既不是 EPERM 也不是 EBUSY，只按 EPERM 判定的兜底逻辑会完全漏掉。
 * 这类错误是瞬时的，退避重试即可成功；而真正的权限不足、磁盘故障
 * 会持续失败，重试只是浪费时间，需要区分对待。
 */

/** 属于「文件被短暂占用」类、值得重试的错误码集合 */
const TRANSIENT_FILE_ERROR_CODES = new Set([
  "UNKNOWN", // libuv 未映射的 Windows 错误（共享冲突 errno -4094 落在这里）
  "EPERM",
  "EBUSY",
  "EACCES",
  "ENOTEMPTY", // 目录项替换瞬时有残留
]);

/** 判定错误是否为「文件被短暂占用」类，适合退避重试 */
export function isTransientFileError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && TRANSIENT_FILE_ERROR_CODES.has(code);
}

export interface RetryOptions {
  /** 最大重试次数（不含首次尝试） */
  retries?: number;
  /** 首次退避毫秒，之后按 2 的幂递增 */
  baseDelayMs?: number;
  /** 额外的错误过滤：返回 false 时不再重试，直接抛出 */
  shouldRetry?: (err: unknown) => boolean;
}

/**
 * 退避重试执行器。
 * 默认 5 次重试，延迟 50/100/200/400/800ms（累计约 1.5s），
 * 足以覆盖外部句柄对文件的短暂占用窗口。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    retries = 5,
    baseDelayMs = 50,
    shouldRetry = isTransientFileError,
  } = options;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !shouldRetry(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastErr;
}
