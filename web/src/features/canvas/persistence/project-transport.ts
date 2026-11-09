/**
 * 画布内容保存传输（原始 Response）。
 * 项目元数据接口归 `entities/project`；这里只承载画布文档的保存协议与
 * keepalive 语义，不重新定义任何元数据接口。
 */
import { apiRaw } from "@/lib/api/client";

/**
 * 保存项目数据（原始 Response）。
 *
 * keepalive 仅在页面真正卸载时使用：它让请求活过页面销毁，
 * 但浏览器对 keepalive 请求体有约 64KB 的硬上限，超出会直接抛
 * TypeError: Failed to fetch。因此页面仍存活的场景（切标签页等）
 * 必须用普通请求，避免大画布保存静默失败。
 */
export function saveProjectRaw(
  id: string | number,
  body: string,
  keepalive = false,
  skipUnauthorized = false,
): Promise<Response> {
  return apiRaw(`/api/canvas/projects/${id}`, {
    method: "PUT",
    body,
    keepalive,
    skipUnauthorized: keepalive || skipUnauthorized,
  });
}

/** 保存画布增量；仅用于卸载阶段整量请求超过 keepalive 配额时。 */
export function saveProjectDeltaRaw(
  id: string | number,
  body: string,
  keepalive = false,
  skipUnauthorized = false,
): Promise<Response> {
  return apiRaw(`/api/canvas/projects/${id}`, {
    method: "PATCH",
    body,
    keepalive,
    skipUnauthorized: keepalive || skipUnauthorized,
  });
}
