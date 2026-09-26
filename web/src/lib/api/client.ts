/**
 * 前端 HTTP 请求统一底座。
 * 凭据由 httpOnly cookie 自动携带（服务端 Set-Cookie 下发），本模块不管理 token，
 * 提供通用 api（成功返回数据、失败抛 ApiError）、apiUploadWithProgress（带进度）、
 * apiRaw（原始 Response）与 apiStream（流式）等底层能力与全局 401 处理。
 * 具体业务接口请使用同目录下的 *-api.ts 模块。
 */
import type { ApiErrorBody } from "@/lib/api/error-message";
import { isRecord, parseErrorBody, resolveApiError } from "@/lib/api/error-message";
import i18n from "@/lib/i18n/config";

// 同源请求：/api/* 由 next.config.ts 的 rewrites 透明代理至 server/ 的 Hono 服务
export const BASE = "";

// ── 全局 401 处理 ──
// 凭据存于 httpOnly cookie（服务端登录/注册时 Set-Cookie 下发），
// 请求自动携带，前端不再管理 token。
// 循环依赖: auth-store → api/client，所以 useAuthStore 必须动态 import
export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

/**
 * 页面会跳转到登录页并重新加载模块，因此该状态无需恢复。
 * 如果未来改为 Refresh Token 自动续期逻辑，需要重新设计此处的状态管理。
 */
let isHandlingUnauthorized = false;

/** 会话过期跳转登录页的一次性提示标记：模块状态不跨整页导航存活，经 sessionStorage 传递 */
export const SESSION_EXPIRED_FLAG = "session_expired";

async function handleUnauthorized() {
  if (isHandlingUnauthorized) return;
  isHandlingUnauthorized = true;

  // 已在登录页（如整页 reload 后 /api/auth/me 再次 401）则不提示不跳转，避免重复
  if (window.location.pathname === "/login") {
    isHandlingUnauthorized = false;
    return;
  }

  // 统一走 store.logout()：服务端过期 httpOnly cookie（JS 无法清除）+ 清用户态与本地缓存。
  // 必须等 cookie 清除完成再跳转：带着残留 cookie 进入受保护页会再次触发 401，形成跳转循环。
  try {
    const { useAuthStore } = await import("@/features/auth/store");
    await useAuthStore.getState().logout();
  } catch {
    // 登出清凭据失败不阻塞跳转
  }

  // 提示由登录页挂载时读取标记展示一次性「会话过期」，跳转本身立即执行
  try {
    sessionStorage.setItem(SESSION_EXPIRED_FLAG, "1");
  } catch { /* sessionStorage 不可用（隐私模式等）时静默跳过提示 */ }
  window.location.href = "/login";
}

/** 检查 HTTP 状态码，401 时触发全局登出流程。返回 true 表示已处理。 */
export function checkUnauthorized(status: number): boolean {
  if (status === 401) {
    handleUnauthorized();
    return true;
  }
  return false;
}

/**
 * API 请求失败：HTTP 非 2xx（status 为实际状态码）或网络层失败（status = 0）。
 * message 已是本地化文案；error/ctx/requestId 为服务端结构化错误信息，
 * 供业务侧做自愈处理（如按 ctx.revision 处理冲突）与展示细节。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly error?: string;
  readonly ctx?: Record<string, string | number>;
  readonly requestId?: string;

  constructor(status: number, message: string, body: ApiErrorBody | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.error = body?.error;
    this.ctx = body?.ctx;
    this.requestId = body?.requestId;
  }
}

/** 2xx 响应体解包：统一 envelope { code, data, msg } 取 data；空响应体（204 等）按 null 处理 */
function unwrapBody<T>(body: unknown): T {
  if (body === null || body === undefined) return null as T;
  if (isRecord(body) && "code" in body && "data" in body) return body.data as T;
  // 所有 /api JSON 接口统一返回 envelope；出现裸 JSON 即服务端契约回归，显式报错而非静默透传
  throw new ApiError(0, i18n.t("error.parse_failed"));
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit & { skipUnauthorized?: boolean } = {}
): Promise<T> {
  const { skipUnauthorized, ...fetchOptions } = options;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...fetchOptions,
      headers: {
        "Content-Type": "application/json",
        ...(fetchOptions.headers || {}),
      },
    });
  } catch {
    throw new ApiError(0, i18n.t("error.network_unreachable"));
  }
  if (!skipUnauthorized && checkUnauthorized(res.status)) throw new UnauthorizedError();
  // 响应体可能为空（204）或是网关返回的 HTML，解析失败按 null 处理，不要抛错
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const errorBody = parseErrorBody(body);
    throw new ApiError(res.status, resolveApiError(errorBody, res.status), errorBody);
  }
  return unwrapBody<T>(body);
}

/**
 * 上传超时常量。
 * XHR 无法区分「慢」与「死」，因此按「空闲时长」判定：只要还有字节在推进，
 * 多大的文件都不会被误杀；一旦连接挂起（既不成功也不失败）则主动中止并报错。
 */
/** 请求体传输阶段：连续这么久没有任何字节推进即判定连接挂起 */
export const UPLOAD_IDLE_TIMEOUT_MS = 30_000;
/** 请求体发完后等待服务端响应的上限（写盘 / 后处理不应让前端无限等待） */
export const UPLOAD_RESPONSE_TIMEOUT_MS = 60_000;
/** 空闲检测轮询间隔 */
const UPLOAD_WATCH_INTERVAL_MS = 1_000;

/** 上传传输层失败类别 */
export type UploadErrorKind = "network" | "timeout" | "http" | "abort";

/** 可重试的 HTTP 状态：请求超时、限流与服务端错误 */
function isRetryableStatus(status?: number): boolean {
  if (!status) return false;
  return status === 408 || status === 429 || status >= 500;
}

/**
 * 上传传输层错误：网络中断、超时、HTTP 非 2xx、请求被中止。
 * retryable 供重试层判定——网络 / 超时 / 5xx 可重试，4xx 直接失败。
 */
export class UploadTransportError extends Error {
  readonly kind: UploadErrorKind;
  readonly retryable: boolean;
  /** HTTP 状态码（仅 kind === "http" 时有值） */
  readonly status?: number;

  constructor(kind: UploadErrorKind, message: string, status?: number) {
    super(message);
    this.name = "UploadTransportError";
    this.kind = kind;
    this.status = status;
    this.retryable = kind === "network" || kind === "timeout" || (kind === "http" && isRetryableStatus(status));
  }
}

/** 安全解析 JSON：网关错误页 / 代理返回 HTML 时返回 null，供错误文案兜底判定 */
function parseJsonSafe(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

export function apiUploadWithProgress<T = unknown>(
  path: string,
  formData: FormData,
  onProgress?: (pct: number) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}${path}`);

    // 挂起检测：传输阶段看字节是否推进，等待响应阶段看服务端是否回应
    let lastActiveAt = Date.now();
    let bodySent = false;
    let settled = false;
    const watcher = setInterval(() => {
      if (settled) return;
      const idle = Date.now() - lastActiveAt;
      if (idle <= (bodySent ? UPLOAD_RESPONSE_TIMEOUT_MS : UPLOAD_IDLE_TIMEOUT_MS)) return;
      settled = true;
      clearInterval(watcher);
      xhr.abort();
      reject(new UploadTransportError("timeout", i18n.t("error.upload.timeout")));
    }, UPLOAD_WATCH_INTERVAL_MS);
    const touch = () => { lastActiveAt = Date.now(); };
    /** 统一收口：定时器只清理一次，且每个分支只会 resolve / reject 一次 */
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(watcher);
      window.removeEventListener("offline", onOffline);
      fn();
    };
    /**
     * 断网立即止损：浏览器不会为「已发出但尚未响应」的 XHR 报错，
     * 只靠超时兜底的话，用户会长时间停在「进度条走完却没有图」的状态。
     */
    const onOffline = () => {
      settle(() => {
        try { xhr.abort(); } catch { /* 请求已结束时 abort 可能抛错，忽略 */ }
        reject(new UploadTransportError("network", i18n.t("error.upload.offline")));
      });
    };
    window.addEventListener("offline", onOffline);

    xhr.upload.onprogress = (e) => {
      touch();
      if (e.lengthComputable) {
        if (e.loaded >= e.total) bodySent = true;
        onProgress?.(Math.round((e.loaded / e.total) * 100));
      }
    };
    // 请求体发完（无论是否带进度回调）→ 切换到「等待响应」超时档位
    xhr.upload.onload = () => { touch(); bodySent = true; };

    xhr.onload = () => {
      settle(() => {
        if (checkUnauthorized(xhr.status)) { reject(new UnauthorizedError()); return; }
        if (xhr.status < 200 || xhr.status >= 300) {
          // 网关错误页、413 等在此收口，不再被误判成网络错误而无效重试。
          // 服务端错误响应带结构化错误码（{ error, ctx }），优先翻译成人话；
          // 解析不出（网关 HTML / 代理错误页）才退回带状态码的兜底文案。
          const body = parseErrorBody(parseJsonSafe(xhr.responseText));
          const message = body?.error
            ? resolveApiError(body, xhr.status, "upload.upload_failed")
            : xhr.status >= 500
              ? i18n.t("error.upload.server_error", { status: xhr.status })
              : i18n.t("error.upload.http_error", { status: xhr.status });
          reject(new UploadTransportError("http", message, xhr.status));
          return;
        }
        try { resolve(unwrapBody<T>(JSON.parse(xhr.responseText))); }
        catch { reject(new UploadTransportError("http", i18n.t("error.parse_failed"), xhr.status)); }
      });
    };
    xhr.onerror = () => settle(() => reject(new UploadTransportError("network", i18n.t("error.network_error"))));
    xhr.onabort = () => settle(() => reject(new UploadTransportError("abort", i18n.t("error.upload.aborted"))));
    xhr.send(formData);
  });
}

export async function apiRaw(
  path: string,
  options: RequestInit & { skipUnauthorized?: boolean } = {}
): Promise<Response> {
  const { skipUnauthorized, ...fetchOptions } = options;
  const res = await fetch(`${BASE}${path}`, {
    ...fetchOptions,
    headers: {
      "Content-Type": "application/json",
      ...(fetchOptions.headers || {}),
    },
  });
  if (!skipUnauthorized) checkUnauthorized(res.status);
  return res;
}

/**
 * 流式请求封装：基于 apiRaw 返回原始 Response，
 * 调用方通过 res.body.getReader() 读取 SSE / 分块流。
 */
export async function apiStream(
  path: string,
  options: RequestInit & { skipUnauthorized?: boolean } = {}
): Promise<Response> {
  return apiRaw(path, options);
}
