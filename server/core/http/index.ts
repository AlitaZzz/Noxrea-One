import { getConfig } from "@server/core/config";

// ── 场景化 HTTP 超时预设（对应 backend/app/config.py 的六组超时） ──

export interface TimeoutPreset {
  connect: number;
  read: number;
  write: number;
  pool: number;
}

export function getTimeoutPreset(scene: "dl" | "poll" | "api" | "async"): TimeoutPreset {
  const cfg = getConfig();

  switch (scene) {
    case "dl":
      return {
        connect: cfg.HTTP_DL_CONNECT,
        read: cfg.HTTP_DL_READ,
        write: cfg.HTTP_DL_WRITE,
        pool: cfg.HTTP_DL_POOL,
      };
    case "poll":
      return {
        connect: cfg.HTTP_POLL_CONNECT,
        read: cfg.HTTP_POLL_READ,
        write: cfg.HTTP_POLL_WRITE,
        pool: cfg.HTTP_POLL_POOL,
      };
    case "api":
      return {
        connect: cfg.HTTP_API_CONNECT,
        read: cfg.HTTP_API_READ,
        write: cfg.HTTP_API_WRITE,
        pool: cfg.HTTP_API_POOL,
      };
    case "async":
      return {
        connect: cfg.HTTP_ASYNC_CONNECT,
        read: cfg.HTTP_ASYNC_READ,
        write: cfg.HTTP_ASYNC_WRITE,
        pool: cfg.HTTP_ASYNC_POOL,
      };
  }
}

/** 获取代理 dispatcher（仅在 USE_SYSTEM_PROXY=true 时生效） */
export function getProxyDispatcher(): unknown {
  const cfg = getConfig();
  if (!cfg.USE_SYSTEM_PROXY || !cfg.PROXY_URL) return undefined;

  // Node.js undici 内置 ProxyAgent（无需额外依赖）
  const { ProxyAgent } = require("undici") as typeof import("undici");
  return new ProxyAgent(cfg.PROXY_URL);
}

/** 带超时的 fetch，支持可选的系统代理 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit & {
    timeoutMs?: number;
    dispatcher?: unknown;
  } = {}
): Promise<Response> {
  const { timeoutMs, dispatcher, ...fetchOptions } = options;

  // 代理：优先使用调用方传入的 dispatcher，其次使用系统代理
  const proxyDispatcher = dispatcher ?? getProxyDispatcher();
  if (proxyDispatcher) {
    (fetchOptions as Record<string, unknown>).dispatcher = proxyDispatcher;
  }

  if (timeoutMs && timeoutMs > 0) {
    const controller = new AbortController();
    const signal = controller.signal;

    // 合并已有 signal
    const existingSignal = fetchOptions.signal;
    if (existingSignal) {
      const onExternalAbort = () => controller.abort();
      existingSignal.addEventListener("abort", onExternalAbort, { once: true });
      // 清理：超时后移除外部信号监听，防止内存泄漏
      const cleanup = () => {
        existingSignal.removeEventListener("abort", onExternalAbort);
      };
      const originalTimer = setTimeout(() => {
        cleanup();
        controller.abort();
      }, timeoutMs);

      fetchOptions.signal = signal;

      try {
        const response = await fetch(url, fetchOptions);
        clearTimeout(originalTimer);
        cleanup();
        return response;
      } catch (err) {
        clearTimeout(originalTimer);
        cleanup();
        throw err;
      }
    }

    fetchOptions.signal = signal;

    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, fetchOptions);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  return fetch(url, fetchOptions);
}

/** 推理服务总超时（对应 HTTP_TIMEOUT_INFERENCE） */
export function getInferenceTimeout(): number {
  return getConfig().HTTP_TIMEOUT_INFERENCE * 1000;
}

/** Worker API 超时（对应 WORKER_API_TIMEOUT） */
export function getWorkerApiTimeout(): number {
  return getConfig().WORKER_API_TIMEOUT * 1000;
}
