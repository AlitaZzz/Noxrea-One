/**
 * 画布项目（Project）与用户偏好（Auth）相关 API 封装。
 * 项目的创建 / 读取 / 重命名 / 删除，以及保存时的 keepalive 原始请求。
 */
import { api, apiRaw } from "./client";

export const projectApi = {
  /** 读取项目（原始 Response，供 save-manager 解析）。 */
  getProjectRaw: (id: string | number): Promise<Response> =>
    apiRaw(`/api/canvas/projects/${id}`),

  /** 项目列表（JSON 包裹）。 */
  listProjects: <T = unknown>() =>
    api<T>(`/api/canvas/projects`),

  /** 读取单个项目（JSON 包裹）。 */
  getProject: <T = unknown>(id: string | number) =>
    api<T>(`/api/canvas/projects/${id}`),

  /** 创建项目。返回类型由调用方泛型指定。 */
  createProject: <T = unknown>(name: string, canvasData?: Record<string, unknown>) =>
    api<T>(`/api/canvas/projects`, { method: "POST", body: JSON.stringify({ name, ...(canvasData ? { canvasData } : {}) }) }),

  /** 重命名 / 局部更新项目（JSON 包裹）。 */
  updateProject: (id: string | number, patch: Record<string, unknown>) =>
    api(`/api/canvas/projects/${id}`, { method: "PUT", body: JSON.stringify(patch) }),

  /** 删除项目。 */
  deleteProject: (id: string | number) =>
    api(`/api/canvas/projects/${id}`, { method: "DELETE" }),

  /**
   * 保存项目数据（原始 Response）。
   * keepalive 用于页面卸载时保活请求，此时无法读取响应体且跳过 401 处理。
   */
  saveProjectRaw: (id: string | number, body: string, keepalive = false): Promise<Response> =>
    apiRaw(`/api/canvas/projects/${id}`, {
      method: "PUT",
      body,
      keepalive,
      skipUnauthorized: keepalive,
    }),
};

/** 用户偏好（Auth）相关接口。 */
export const authApi = {
  /** 获取当前用户信息（GET /api/auth/me）。 */
  me: <T = unknown>() =>
    api<T>("/api/auth/me"),

  /** 登录（POST /api/auth/login）。返回类型由调用方泛型指定。 */
  login: <T = unknown>(username: string, password: string) =>
    api<T>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      skipUnauthorized: true,
    }),

  /** 注册（POST /api/auth/register）。返回类型由调用方泛型指定。 */
  register: <T = unknown>(username: string, password: string) =>
    api<T>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      skipUnauthorized: true,
    }),

  /** 局部更新当前用户字段（如 lastName / displayName 等）。 */
  updateMe: (patch: Record<string, unknown>) =>
    api("/api/auth/me", { method: "PUT", body: JSON.stringify(patch) }),
};
