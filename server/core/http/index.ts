import { getConfig } from "@server/core/config";

// ── 场景化 HTTP 超时 ──

export type HttpTimeoutScene = "dl" | "poll" | "api" | "async";

/** 按场景获取超时（毫秒） */
export function getSceneTimeout(scene: HttpTimeoutScene): number {
  const cfg = getConfig();
  switch (scene) {
    case "dl":    return cfg.HTTP_TIMEOUT_DL    * 1000;
    case "poll":  return cfg.HTTP_TIMEOUT_POLL  * 1000;
    case "api":   return cfg.HTTP_TIMEOUT_API   * 1000;
    case "async": return cfg.HTTP_TIMEOUT_ASYNC * 1000;
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
    scene?: HttpTimeoutScene;
    dispatcher?: unknown;
  } = {}
): Promise<Response> {
  const { timeoutMs, scene, dispatcher, ...fetchOptions } = options;

  const effectiveTimeout = timeoutMs ?? (scene ? getSceneTimeout(scene) : 0);

  // 代理：优先使用调用方传入的 dispatcher，其次使用系统代理
  const proxyDispatcher = dispatcher ?? getProxyDispatcher();
  if (proxyDispatcher) {
    (fetchOptions as Record<string, unknown>).dispatcher = proxyDispatcher;
  }

  if (effectiveTimeout > 0) {
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
      }, effectiveTimeout);

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

    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

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
