/**
 * 场景化 HTTP 客户端。
 * 按下载、轮询、接口、异步等场景提供差异化的超时与请求封装。
 *
 * 超时语义分三段，均汇入同一个 AbortController：
 *   - headers timeout（timeoutMs / scene）：DNS/TCP/TLS + 等待响应头
 *   - body idle timeout（bodyIdleTimeoutMs，默认 HTTP_BODY_IDLE_TIMEOUT）：响应体内相邻数据块的最大空闲
 *   - overall timeout（overallTimeoutMs，可选）：请求发起到 body 读完的总时长上限
 *
 * 此前超时 timer 在 fetch() 返回 Response 后即清除，body 读取完全无保护
 * （仅在 undici 默认 bodyTimeout 的隐式兜底下不出大事），慢滴漏响应可无限占用调用方。
 */
import { ProxyAgent } from "undici";
import { getConfig, isProxyRoutingEnabled } from "@server/core/config";
import { getSsrfAgent } from "@server/core/ssrf";

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

/**
 * 统一超时错误：name=TimeoutError + undici 风格 code，
 * 上层（sync-fetch 的失败分类、download 的可重试判定）据此识别超时而无需感知本模块的定时器实现。
 */
export class HttpTimeoutError extends Error {
  readonly code: string;
  constructor(message: string, code: "UND_ERR_HEADERS_TIMEOUT" | "UND_ERR_BODY_TIMEOUT") {
    super(message);
    this.name = "TimeoutError";
    this.code = code;
  }
}

/** 代理 dispatcher 单例：按 PROXY_URL 值缓存，配置变化时重建。
    此前每次请求 new ProxyAgent 且不复用不 close，keep-alive 连接池随 GC 才释放 */
let cachedProxyUrl: string | null = null;
let cachedProxyAgent: ProxyAgent | null = null;

/** 获取代理 dispatcher（仅在配置了系统代理时生效） */
export function getProxyDispatcher(): unknown {
  if (!isProxyRoutingEnabled()) return undefined;

  const proxyUrl = getConfig().PROXY_URL;
  if (cachedProxyUrl !== proxyUrl || !cachedProxyAgent) {
    cachedProxyAgent?.close().catch(() => {});
    cachedProxyAgent = new ProxyAgent(proxyUrl);
    cachedProxyUrl = proxyUrl;
  }
  return cachedProxyAgent;
}

/** 给响应体套上 idle/overall 超时看门狗：数据到达重置 idle，到期经 controller.abort 中止上游连接。
    错误归一化：controller 携带的 HttpTimeoutError 优先透出，其余原样透传 */
function withBodyWatchdog(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  idleMs: number,
  onSettle: () => void
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  // 消费者取消与在途 pull 的竞态标记：cancel 触发底层 reader.cancel 后，
  // 挂起中的 read 会以 done/数据落定，此时不得再 close/enqueue 已关闭的流
  let cancelled = false;

  const settle = () => {
    if (settled) return;
    settled = true;
    if (idleTimer) clearTimeout(idleTimer);
    onSettle();
  };

  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (idleMs > 0) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          controller.abort(
            new HttpTimeoutError(`response body idle: no data for ${idleMs}ms`, "UND_ERR_BODY_TIMEOUT")
          );
        }, idleMs);
      }
      try {
        const { done, value } = await reader.read();
        // 数据已到手（或流已结束），本次等待的空闲期结束；下次 pull 重新计时
        if (idleTimer) clearTimeout(idleTimer);
        if (cancelled) return;
        if (done) {
          settle();
          ctrl.close();
          return;
        }
        ctrl.enqueue(value);
      } catch (err) {
        settle();
        const reason = controller.signal.reason;
        ctrl.error(reason instanceof HttpTimeoutError ? reason : err);
      }
    },
    cancel(reason) {
      cancelled = true;
      settle();
      return reader.cancel(reason);
    },
  });
}

/** 带完整生命周期超时的 fetch，支持可选的系统代理 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit & {
    timeoutMs?: number;
    scene?: HttpTimeoutScene;
    dispatcher?: unknown;
    /** 仅影响 TCP 建连阶段的超时（毫秒），绕过 undici 默认的 10s 连接超时 */
    connectTimeoutMs?: number;
    /** body 相邻数据块的最大空闲（毫秒）；缺省取 HTTP_BODY_IDLE_TIMEOUT，0 = 关闭 body 看门狗 */
    bodyIdleTimeoutMs?: number;
    /** 请求发起到 body 读完的总时长上限（毫秒）；不设则不限 */
    overallTimeoutMs?: number;
  } = {}
): Promise<Response> {
  const {
    timeoutMs, scene, dispatcher, connectTimeoutMs, bodyIdleTimeoutMs, overallTimeoutMs,
    signal: externalSignal, ...fetchOptions
  } = options;

  const headersTimeoutMs = timeoutMs ?? (scene ? getSceneTimeout(scene) : 0);
  const bodyIdleMs = bodyIdleTimeoutMs ?? getConfig().HTTP_BODY_IDLE_TIMEOUT * 1000;

  // 代理模式：DNS 由代理解析，SSRF 预检降级为告警（见 core/ssrf）；
  // 直连模式：默认走 SSRF 校验型 Agent，建连 lookup 阶段校验并 pinning 校验通过的 IP，
  // 覆盖重定向后的每一跳
  const proxyDispatcher = dispatcher ?? getProxyDispatcher();
  if (proxyDispatcher) {
    (fetchOptions as Record<string, unknown>).dispatcher = proxyDispatcher;
    if (connectTimeoutMs && connectTimeoutMs > 0) {
      (fetchOptions as Record<string, unknown>).connect = { timeout: connectTimeoutMs };
    }
  } else {
    (fetchOptions as Record<string, unknown>).dispatcher = getSsrfAgent(
      connectTimeoutMs && connectTimeoutMs > 0 ? connectTimeoutMs : undefined
    );
  }

  // 生命周期统一控制器：headers 超时、body idle、overall、外部 signal 全部汇入
  const controller = new AbortController();
  (fetchOptions as Record<string, unknown>).signal = controller.signal;

  let detachExternal = () => {};
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      const onExternalAbort = () => controller.abort(externalSignal.reason);
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      detachExternal = () => externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }

  let headersTimer: ReturnType<typeof setTimeout> | undefined;
  if (headersTimeoutMs > 0) {
    headersTimer = setTimeout(() => {
      controller.abort(
        new HttpTimeoutError(`response headers timeout: no headers for ${headersTimeoutMs}ms`, "UND_ERR_HEADERS_TIMEOUT")
      );
    }, headersTimeoutMs);
  }

  // overall 跨越 headers + body 两个阶段，到 stream 结束/出错/取消才清
  let overallTimer: ReturnType<typeof setTimeout> | undefined;
  if (overallTimeoutMs !== undefined && overallTimeoutMs > 0) {
    overallTimer = setTimeout(() => {
      controller.abort(
        new HttpTimeoutError(`overall request timeout after ${overallTimeoutMs}ms`, "UND_ERR_BODY_TIMEOUT")
      );
    }, overallTimeoutMs);
  }

  /** body 流结束/出错/取消或 fetch 失败后的统一收尾 */
  const settle = () => {
    if (overallTimer) clearTimeout(overallTimer);
    detachExternal();
  };

  try {
    const response = await fetch(url, fetchOptions);
    // 响应头已就绪：headers 超时完成使命
    if (headersTimer) clearTimeout(headersTimer);

    if (!response.body || (bodyIdleMs <= 0 && overallTimer === undefined)) {
      settle();
      return response;
    }

    return new Response(withBodyWatchdog(response.body, controller, bodyIdleMs, settle), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (err) {
    if (headersTimer) clearTimeout(headersTimer);
    settle();
    throw err;
  }
}

/** Worker API 超时（对应 WORKER_API_TIMEOUT） */
export function getWorkerApiTimeout(): number {
  return getConfig().WORKER_API_TIMEOUT * 1000;
}
