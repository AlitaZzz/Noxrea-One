/**
 * 模型配置（Model Config）相关 API 封装：供应商与模型的管理、能力开关与模型列表拉取。
 */
import { api, apiRaw } from "@/lib/api/client";

export const modelApi = {
  /** 更新供应商（名称 / baseUrl / apiKey / protocol / config）。 */
  updateProvider: (id: string, patch: Record<string, unknown>) =>
    api(`/api/model-config/providers/${id}`, { method: "PUT", body: JSON.stringify(patch) }),

  /** 删除供应商。 */
  deleteProvider: (id: string) =>
    api(`/api/model-config/providers/${id}`, { method: "DELETE" }),

  /** 向供应商新增模型。 */
  addModel: (providerId: string, name: string) =>
    api<{ id: string }>(`/api/model-config/providers/${providerId}/models`, {
      method: "POST",
      body: JSON.stringify({ name, capabilities: [] }),
    }),

  /** 设置模型能力集合（覆盖式）。 */
  setModelCapability: (providerId: string, modelId: string, capabilities: string[]) =>
    api(`/api/model-config/providers/${providerId}/models/${modelId}/capability`, {
      method: "PUT",
      body: JSON.stringify({ capabilities }),
    }),

  /** 批量设置供应商下模型列表。 */
  setProviderModels: (providerId: string, models: unknown[]) =>
    api(`/api/model-config/providers/${providerId}/models/set`, {
      method: "POST",
      body: JSON.stringify({ models }),
    }),

  /** 拉取供应商明文 apiKey（按需揭示）。 */
  fetchProviderApiKey: (id: string) =>
    api<{ apiKey: string }>(`/api/model-config/providers/${id}/apikey`),

  /** 拉取全部供应商配置（可指定返回类型）。 */
  fetchProviders: <T = unknown[]>() =>
    api<T>(`/api/model-config/providers`),

  /** 创建供应商。 */
  createProvider: (name: string, baseUrl: string, apiKey: string, protocol?: string) =>
    api<{ id: string }>(`/api/model-config/providers`, {
      method: "POST",
      body: JSON.stringify({ name, baseUrl: baseUrl.replace(/\/$/, ""), apiKey, protocol }),
    }),

  /** 拉取模型参数定义。 */
  fetchModelParams: <T = unknown>() =>
    api<T>(`/api/model-params`),

  /** 拉取供应商预设。 */
  fetchPresets: <T = unknown>() =>
    api<T>(`/api/model-config/presets`),

  /** 拉取某供应商下的远端模型列表（原始 Response，调用方自行解析 data）。 */
  fetchModelsList: (providerId: string): Promise<Response> =>
    apiRaw(`/api/models/list`, { method: "POST", body: JSON.stringify({ providerId }) }),
};
