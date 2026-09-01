/**
 * 前端 HTTP 请求统一底座。
 * 封装 token 读写与请求头注入、全局 401 处理、错误提示，
 * 提供通用 api（JSON 包裹）、apiUpload（表单）、apiUploadWithProgress（带进度）、
 * apiRaw（原始 Response）与 apiStream（流式）等底层能力。
 * 具体业务接口请使用同目录下的 *-api.ts 模块。
 */
import { showGlobalNotification } from "@/lib/global-notification";
import i18n from "@/lib/i18n/config";

// 同源请求：/api/* 由 next.config.ts 的 rewrites 透明代理至 server/ 的 Hono 服务
export const BASE = "";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("noxrea-auth-token");
}

export function setToken(token: string | null) {
  if (!token) {
    localStorage.removeItem("noxrea-auth-token");
  } else {
    localStorage.setItem("noxrea-auth-token", token);
  }
}

export function getTokenHeader(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── 全局 401 处理 ──
// 循环依赖: auth-store → api/client，所以 useAuthStore 必须动态 import
export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
    // ES2015 以下目标需显式设置原型链，当前 Next.js/swc 编译目标为现代浏览器，
    // 此行保留作为防御性编程，对目标环境无害。
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

/**
 * 页面会跳转到登录页并重新加载模块，因此该状态无需恢复。
 * 如果未来改为 Refresh Token 自动续期逻辑，需要重新设计此处的状态管理。
 */
let isHandlingUnauthorized = false;

function handleUnauthorized() {
  if (isHandlingUnauthorized) return;
  isHandlingUnauthorized = true;

  // 同步清除 localStorage token，不依赖异步 import，防止页面跳转后 token 未清除导致循环
  setToken(null);

  import("@/features/auth/store").then(({ useAuthStore }) => {
    useAuthStore.getState().logout();
  });

  // 已在登录页（如整页 reload 后 /api/auth/me 再次 401）则不弹提示，避免重复提示
  if (window.location.pathname !== "/login") {
    showGlobalNotification().error({
      title: i18n.t("error.session_expired"),
      description: i18n.t("error.session_expired_desc"),
      placement: "bottomRight",
      duration: 5,
    });
  }

  // 延迟跳转，让 toast 可见
  // TODO: 多 Tab 同步 — 监听 window "storage" 事件，token 被清除时同步 logout
  setTimeout(() => {
    // 已在登录页则不再跳转，防止 token 清除前的并发 401 导致循环
    if (window.location.pathname === "/login") return;
    window.location.href = "/login";
  }, 300);
}

/** 检查 HTTP 状态码，401 时触发全局登出流程。返回 true 表示已处理。 */
export function checkUnauthorized(status: number): boolean {
  if (status === 401) {
    handleUnauthorized();
    return true;
  }
  return false;
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit & { skipUnauthorized?: boolean } = {}
): Promise<{ code: number; data: T; msg: string }> {
  const { skipUnauthorized, ...fetchOptions } = options;
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...fetchOptions,
      headers: {
        "Content-Type": "application/json",
        ...getTokenHeader(),
        ...(fetchOptions.headers || {}),
      },
    });
    if (!skipUnauthorized && checkUnauthorized(res.status)) throw new UnauthorizedError();
    return await res.json();
  } catch (e) {
    if (e instanceof UnauthorizedError) throw e;
    return { code: 0, data: null as T, msg: i18n.t("error.network_unreachable") };
  }
}

export async function apiUpload<T = unknown>(
  path: string,
  formData: FormData,
  skipUnauthorized = false
): Promise<{ code: number; data: T; msg: string }> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: getTokenHeader(),
      body: formData,
    });
    if (!skipUnauthorized && checkUnauthorized(res.status)) throw new UnauthorizedError();
    return await res.json();
  } catch (e) {
    if (e instanceof UnauthorizedError) throw e;
    return { code: 0, data: null as T, msg: i18n.t("error.network_unreachable") };
  }
}

/**
 * 上传超时常量。
 * XHR 无法区分「慢」与「死」，因此按「空闲时长」判定：只要还有字节在推进，
 * 多大的文件都不会被误杀；一旦连接挂起（既不成功也不失败）则主动中止并报错。
 */
/** 请求体传输阶段：连续这么久没有任何字节推进即判定连接挂起 */
export const UPLOAD_IDLE_TIMEOUT_MS = 30_000;
/** 请求体发完后等待服务端响应的上限（写盘 / 后处理不应让前端无限等待） */
export const UPLOAD_RESPONSE_TIMEOUT_MS = 120_000;
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
    Object.setPrototypeOf(this, UploadTransportError.prototype);
  }
}

export function apiUploadWithProgress<T = unknown>(
  path: string,
  formData: FormData,
  onProgress?: (pct: number) => void
): Promise<{ code: number; data: T; msg: string }> {
  const token = getToken();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}${path}`);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

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
      fn();
    };

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
          // 网关错误页、413 等在此收口，不再被误判成网络错误而无效重试
          const message = xhr.status >= 500
            ? i18n.t("error.upload.server_error", { status: xhr.status })
            : i18n.t("error.upload.http_error", { status: xhr.status });
          reject(new UploadTransportError("http", message, xhr.status));
          return;
        }
        try { resolve(JSON.parse(xhr.responseText)); }
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
      ...getTokenHeader(),
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
