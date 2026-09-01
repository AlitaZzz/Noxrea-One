/**
 * 画布项目（Project）相关 API 封装。
 * 项目的创建 / 读取 / 重命名 / 删除，以及保存时的 keepalive 原始请求。
 */
import { api, apiRaw } from "@/lib/api/client";

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
   *
   * keepalive 仅在页面真正卸载时使用：它让请求活过页面销毁，
   * 但浏览器对 keepalive 请求体有约 64KB 的硬上限，超出会直接抛
   * TypeError: Failed to fetch。因此页面仍存活的场景（切标签页等）
   * 必须用普通请求，避免大画布保存静默失败。
   */
  saveProjectRaw: (
    id: string | number,
    body: string,
    keepalive = false,
    skipUnauthorized = false,
  ): Promise<Response> =>
    apiRaw(`/api/canvas/projects/${id}`, {
      method: "PUT",
      body,
      keepalive,
      skipUnauthorized: keepalive || skipUnauthorized,
    }),
};
