/**
 * 项目元数据 API（entity 内部使用，不对 feature 暴露 API 对象）。
 * 画布内容的保存传输归 `features/canvas` 的持久化层。
 */
import { api } from "@/lib/api/client";

/** 项目列表（JSON 包裹）。 */
export function listProjects<T = unknown>(): Promise<T> {
  return api<T>(`/api/canvas/projects`);
}

/** 创建项目；服务端固定以空画布建立文档，客户端不提交画布内容。 */
export function createProject<T = unknown>(name: string): Promise<T> {
  return api<T>(`/api/canvas/projects`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/** 重命名 / 局部更新项目（JSON 包裹）。 */
export function updateProject<T = { revision: number }>(
  id: string | number,
  patch: Record<string, unknown>,
): Promise<T> {
  return api<T>(`/api/canvas/projects/${id}`, { method: "PUT", body: JSON.stringify(patch) });
}

/** 删除项目。 */
export function deleteProject(id: string | number): Promise<unknown> {
  return api(`/api/canvas/projects/${id}`, { method: "DELETE" });
}
