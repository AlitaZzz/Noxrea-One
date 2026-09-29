/**
 * 上游同步执行段：fetch + 超时/网络失败分类 + HTTP 错误体读取 + 空结果判失败。
 *
 * 此前这段逻辑在 manager（image/video 提交路径）与 llm/audio 能力服务中各自实现，
 * 能力侧缺少超时/网络分类与空结果判失败（空文本会静默 completed）。
 * 统一收敛于此：异步轮询的升级判定（extractTaskId → poll）仍属 manager，
 * 本模块只覆盖「单次同步请求」这一段。
 */

import { logger } from "@server/core/logger";
import { logEvent } from "@server/core/logger/utils";
import { fetchWithTimeout, getWorkerApiTimeout } from "@server/core/http-client";
import { extractUpstreamMessage, failFromUpstream } from "@server/services/tasks/failure";

export interface UpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export type UpstreamFetchOutcome =
  /** 2xx 且响应体解析为 JSON */
  | { kind: "data"; data: unknown }
  /** 非 2xx：原始错误体交由调用方（异步链路可能从中提取 task_id 升级轮询） */
  | { kind: "http-error"; status: number; errText: string; errData: unknown }
  /** 超时 / 网络失败（含 2xx 响应体非 JSON 的解析失败）：已带最终分类 */
  | { kind: "failure"; error: string; errorCode: string };

/**
 * 发送一次上游同步请求。
 * - 2xx → 解析 JSON 返回 data（解析失败按网络失败分类，与旧 submitAndWait 行为一致）
 * - 非 2xx → 返回原始错误体文本与解析结果（errData 解析失败为空对象）
 * - fetch 抛错 → 按 TimeoutError / 其余二分给出最终失败分类
 */
export async function fetchUpstream(
  req: UpstreamRequest,
  taskId: string,
  logChannel = "taskmgr",
  signal?: AbortSignal
): Promise<UpstreamFetchOutcome> {
  try {
    const response = await fetchWithTimeout(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ? JSON.stringify(req.body) : undefined,
      timeoutMs: getWorkerApiTimeout(),
      signal,
    });

    if (!response.ok) {
      // 错误响应体统一文本读取：JSON 体由提取器解析，纯文本体（网关错误页等）原样截断透传；
      // task_id 只可能出现在 JSON 体中，解析失败即无 ID 可提取
      const rawErrText = await response.text().catch(() => "");
      let errData: unknown = {};
      try {
        errData = JSON.parse(rawErrText);
      } catch {
        // 非 JSON 体
      }
      return { kind: "http-error", status: response.status, errText: rawErrText, errData };
    }

    const data = await response.json();
    logger.debug({ taskId, keys: Object.keys(data as object) }, "upstream response");
    return { kind: "data", data };
  } catch (err: unknown) {
    const e = err as Error & { code?: string; cause?: { code?: string; message?: string } };
    // 超时统一分类：headers 阶段（fetchWithTimeout / undici 原生 headersTimeout）与
    // body 阶段（body idle / overall 看门狗、undici 原生 bodyTimeout）都属 generation.timeout
    if (
      e.name === "TimeoutError" ||
      e.code === "UND_ERR_HEADERS_TIMEOUT" ||
      e.code === "UND_ERR_BODY_TIMEOUT"
    ) {
      return {
        kind: "failure",
        error: "API call timed out",
        errorCode: "generation.timeout",
      };
    }
    const cause = e.cause;
    const detail = cause
      ? `${e.message} [cause: ${cause.code ?? cause.message}]`
      : (e.message ?? "Unknown error");
    logEvent(logChannel, { level: "warn", stage: "upstream_network_error", taskId, error: detail });
    return {
      kind: "failure",
      error: detail.slice(0, 200),
      errorCode: "generation.network_error",
    };
  }
}

/**
 * HTTP 非 2xx 的统一翻译：优先回传上游自带的可读文案
 * （取不到时回退状态码文案 + generation.upstream_http_error 分类）。
 */
export function httpUpstreamFailure(
  status: number,
  errText: string
): { error: string; errorCode?: string } {
  return failFromUpstream(extractUpstreamMessage(errText), {
    message: `HTTP ${status}`,
    code: "generation.upstream_http_error",
  });
}

/**
 * 同步响应既无结果内容的统一判失败（空文本静默 completed 的根治出口）。
 * 优先回传上游自带的失败文案，取不到时回退调用方给的场景文案 +
 * generation.upstream_no_result 分类。
 */
export function noUpstreamResult(
  data: unknown,
  fallbackMessage: string
): { error: string; errorCode?: string } {
  return failFromUpstream(extractUpstreamMessage(data), {
    message: fallbackMessage,
    code: "generation.upstream_no_result",
  });
}
