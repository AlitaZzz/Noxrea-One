/**
 * 模型配置（Model Config）相关 API 封装：通道与模型的管理、能力开关与模型列表拉取。
 */
import { api, apiRaw } from "./client";

export const modelApi = {
  /** 更新通道（名称 / baseUrl / apiKey / protocol / config）。 */
  updateChannel: (id: string, patch: Record<string, unknown>) =>
    api(`/api/model-config/channels/${id}`, { method: "PUT", body: JSON.stringify(patch) }),

  /** 删除通道。 */
  deleteChannel: (id: string) =>
    api(`/api/model-config/channels/${id}`, { method: "DELETE" }),

  /** 向通道新增模型。 */
  addModel: (channelId: string, name: string) =>
    api<{ id: string }>(`/api/model-config/channels/${channelId}/models`, {
      method: "POST",
      body: JSON.stringify({ name, capabilities: [] }),
    }),

  /** 设置模型能力集合（覆盖式）。 */
  setModelCapability: (channelId: string, modelId: string, capabilities: string[]) =>
    api(`/api/model-config/channels/${channelId}/models/${modelId}/capability`, {
      method: "PUT",
      body: JSON.stringify({ capabilities }),
    }),

  /** 批量设置通道下模型列表。 */
  setChannelModels: (channelId: string, models: unknown[]) =>
    api(`/api/model-config/channels/${channelId}/models/set`, {
      method: "POST",
      body: JSON.stringify({ models }),
    }),

  /** 拉取全部通道配置（可指定返回类型）。 */
  fetchChannels: <T = unknown[]>() =>
    api<T>(`/api/model-config/channels`),

  /** 创建通道。 */
  createChannel: (name: string, baseUrl: string, apiKey: string, protocol?: string, config?: Record<string, unknown>) =>
    api<{ id: string }>(`/api/model-config/channels`, {
      method: "POST",
      body: JSON.stringify({ name, baseUrl: baseUrl.replace(/\/$/, ""), apiKey, protocol, config }),
    }),

  /** 拉取模型参数定义。 */
  fetchModelParams: <T = unknown>() =>
    api<T>(`/api/model-params`),

  /** 拉取供应商预设。 */
  fetchPresets: <T = unknown>() =>
    api<T>(`/api/model-config/presets`),

  /** 拉取某通道下的远端模型列表（原始 Response，调用方自行解析 data）。 */
  fetchModelsList: (channelId: string): Promise<Response> =>
    apiRaw(`/api/models/list`, { method: "POST", body: JSON.stringify({ channelId }) }),
};
