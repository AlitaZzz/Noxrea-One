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
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (checkUnauthorized(xhr.status)) { reject(new UnauthorizedError()); return; }
      try { resolve(JSON.parse(xhr.responseText)); }
      catch { reject(new Error(i18n.t("error.parse_failed"))); }
    };
    xhr.onerror = () => reject(new Error(i18n.t("error.network_error")));
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
