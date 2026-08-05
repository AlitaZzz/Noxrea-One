/**
 * 前端 HTTP 请求统一入口。
 * 封装 token 读写与请求头注入、全局 401 处理、错误提示，
 * 并提供通用 api、文件上传（含进度）及资产等业务接口封装。
 */
import { showGlobalMessage } from "@/lib/global-message";

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
// 循环依赖: auth-store → api.ts，所以 useAuthStore 必须动态 import
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

  import("@/stores/auth-store").then(({ useAuthStore }) => {
    useAuthStore.getState().logout();
  });

  // 已在登录页（如整页 reload 后 /api/auth/me 再次 401）则不弹提示，避免重复提示
  if (window.location.pathname !== "/login") {
    showGlobalMessage().error("登录已过期，请重新登录");
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
    return { code: 0, data: null as T, msg: "Unable to connect to server. Please check if the backend is running." };
  }
}

export async function apiUpload<T = unknown>(path: string, formData: FormData, skipUnauthorized = false): Promise<{ code: number; data: T; msg: string }> {
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
    return { code: 0, data: null as T, msg: "Unable to connect to server. Please check if the backend is running." };
  }
}

export function apiUploadWithProgress<T = unknown>(
  path: string,
  formData: FormData,
  onProgress?: (pct: number) => void,
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
      catch { reject(new Error("Parse failed")); }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(formData);
  });
}

// --- 原始请求底座（供 keepalive / 流式 / 自定义解析使用） ---
/**
 * 低层 fetch 封装：自动注入同源 BASE、token 头与 401 拦截，
 * 返回原始 Response，行为与 fetch 一致（不解析 JSON、不包裹返回值）。
 * 适用于需要 keepalive、流式读取或自定义响应解析的请求。
 * 普通 JSON 请求请直接使用 api() / apiUpload()。
 */
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

// --- Asset API ---

export interface AssetFolderDto {
  id: number;
  userId: number;
  name: string;
  spaceKey: string;
  parentId: number | null;
  createdAt: string;
  count: number;
}

export interface AssetItemDto {
  id: number;
  userId: number;
  folderId: number | null;
  spaceKey: string;
  name: string;
  type: string;
  mediaType: string;
  width: number;
  height: number;
  description: string;
  tags: string[];
  extraData: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// Folders
export const assetApi = {
  listFolders: (spaceKey = "personal") =>
    api<AssetFolderDto[]>(`/api/assets/folders?space_key=${spaceKey}`),

  createFolder: (name: string, spaceKey = "personal", parentId?: number) =>
    api<AssetFolderDto>("/api/assets/folders", {
      method: "POST",
      body: JSON.stringify({ name, spaceKey, parentId: parentId ?? null }),
    }),

  updateFolder: (id: number, name: string) =>
    api<AssetFolderDto>(`/api/assets/folders/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),

  deleteFolder: (id: number) =>
    api(`/api/assets/folders/${id}`, { method: "DELETE" }),

  // Assets
  listAssets: (params?: { folderId?: number; type?: string; search?: string; spaceKey?: string; skip?: number; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params?.folderId !== undefined) sp.set("folder_id", String(params.folderId));
    if (params?.type) sp.set("type", params.type);
    if (params?.search) sp.set("search", params.search);
    if (params?.spaceKey) sp.set("space_key", params.spaceKey);
    if (params?.skip !== undefined) sp.set("skip", String(params.skip));
    if (params?.limit !== undefined) sp.set("limit", String(params.limit));
    const qs = sp.toString();
    return api<{ items: AssetItemDto[]; total: number }>(`/api/assets/items${qs ? `?${qs}` : ""}`);
  },

  createAsset: (data: {
    name: string; type: string; mediaType?: string;
    width?: number; height?: number;
    description?: string; tags?: string[]; extraData?: Record<string, unknown>; folderId?: number; spaceKey?: string;
  }) =>
    api<AssetItemDto>("/api/assets/items", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  createAssetsBatch: (items: Array<{
    name: string; type: string; mediaType?: string;
    width?: number; height?: number;
    description?: string; tags?: string[]; extraData?: Record<string, unknown>; folderId?: number; spaceKey?: string;
  }>) =>
    api<AssetItemDto[]>("/api/assets/items/batch", {
      method: "POST",
      body: JSON.stringify(items),
    }),

  updateAsset: (id: number, data: Record<string, unknown>) =>
    api<AssetItemDto>(`/api/assets/items/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deleteAsset: (id: number) =>
    api(`/api/assets/items/${id}`, { method: "DELETE" }),

  updateAssetsBatch: (ids: number[], updates: Record<string, unknown>) =>
    api<{ count: number }>("/api/assets/items/batch", {
      method: "PUT",
      body: JSON.stringify({ ids, updates }),
    }),

  listSourceUrls: (spaceKey = "personal") =>
    api<string[]>(`/api/assets/items/source-urls?space_key=${spaceKey}`),
};
