export class SessionChangedError extends Error {
  constructor() {
    super("Session changed");
    this.name = "SessionChangedError";
  }
}

let controller = new AbortController();
const listeners = new Set<() => void>();
/**
 * 当前账号标识（登录用户 id）；未登录为 null。
 *
 * 会话作用域级缓存（含设备本地持久化）以它为键：同一浏览器上的账号切换必须能
 * 区分「谁的缓存」，仅靠进程内计数器无法给落盘条目归属。
 */
let account: string | null = null;

export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 当前账号标识；未登录或尚未完成鉴权初始化时为 null */
export function currentAccountKey(): string | null {
  return account;
}

/**
 * Invalidate work before resetting account-owned caches.
 * @param accountKey 新账号标识（登录用户 id）；登出或失效会话传 null
 */
export function changeSession(accountKey: string | null = null): void {
  account = accountKey;
  const previous = controller;
  controller = new AbortController();
  previous.abort(new SessionChangedError());
  for (const listener of listeners) listener();
}

export function captureSession() {
  const signal = controller.signal;
  const assertCurrent = () => {
    if (signal.aborted) throw new SessionChangedError();
  };
  return {
    signal,
    assertCurrent,
    async run<T>(task: () => Promise<T>): Promise<T> {
      assertCurrent();
      try {
        return await task();
      } finally {
        // Also discard failures: an old request must not affect the new session.
        assertCurrent();
      }
    },
  };
}
