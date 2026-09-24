/**
 * 模型与供应商状态仓库。
 * 管理供应商及其模型清单的增删改、能力标记，
 * 支持从供应商远端拉取模型列表、读取服务商预设与模型参数配置缓存。
 */
import { create } from "zustand";

import { modelApi } from "@/features/settings/api";
import { ApiError } from "@/lib/api/client";
import {
  isRecord,
  parseErrorBody,
  resolveApiError,
} from "@/lib/api/error-message";
import { showGlobalNotification } from "@/lib/global-notification";
import i18n from "@/lib/i18n/config";
import type { ModelCapability, ModelParamConfig,ModelProvider, ProviderPreset } from "@/lib/types/models";

/** 写操作失败提示（store 层统一负责，UI 只处理成功分支）；e 为 ApiError 时 message 已本地化 */
function notifyFailure(e: unknown, fallbackKey: string) {
  showGlobalNotification().error({
    title: e instanceof ApiError ? e.message : resolveApiError(null, undefined, fallbackKey),
    placement: "bottomRight",
    duration: 6,
  });
}

/** 拉取远端模型列表失败：toast 统一在此弹出，调用方只处理成功分支 */
function fetchModelsFailure(msg: string): { success: false; error: string } {
  showGlobalNotification().error({ title: msg, placement: "bottomRight", duration: 6 });
  return { success: false, error: msg };
}

/** 从 baseUrl 解析 host（供上游通配匹配用） */
function hostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

/** 通配符 → 正则（带缓存：findModelParams 每次渲染都会调用，避免重复编译）。
 *  host 键支持 "|" 分隔多模式（如 "*apimart*|*exellome*"），与后端 matchHost 语义一致。 */
const patternRegexCache = new Map<string, RegExp>();
function patternToRegex(pattern: string): RegExp {
  let re = patternRegexCache.get(pattern);
  if (!re) {
    const source = pattern
      .split("|")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => "^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$")
      .join("|");
    // 全空段（如键误写为 "|"）时无可匹配模式，用永不命中的正则与后端 matchPatternKey 对齐
    re = new RegExp(source || "(?!)");
    patternRegexCache.set(pattern, re);
  }
  return re;
}

interface RawModelEntry {
  id?: string;
  name?: string;
}

/**
 * model-ui.json v2 结构：
 *   - `_default`：capability → 配置（两层）
 *   - host 通配条目：模型名 → capability → 配置（三层），另有 `_endpoints` 路由键
 */
type ModelParamsMap = Record<string, Record<string, ModelParamConfig> | Record<string, Record<string, ModelParamConfig>>>;

interface ModelState {
  providers: ModelProvider[];
  presets: ProviderPreset[];
  modelParamsCache: ModelParamsMap;
  /** 拉取成功（含空列表）为 true；失败保持 false 以允许后续调用重试 */
  initialized: boolean;
  /** 首次拉取失败标记，供 UI 展示重试入口 */
  initializeFailed: boolean;
  initialize: () => Promise<void>;
  findModelParams: (providerId: string, modelName: string, capability: string) => ModelParamConfig | null;

  addProvider: (name: string, baseUrl: string, apiKey: string, protocol?: string) => Promise<boolean>;
  updateProvider: (id: string, patch: Partial<Pick<ModelProvider, "name" | "baseUrl" | "apiKey" | "protocol">>) => Promise<boolean>;
  fetchProviderApiKey: (id: string) => Promise<string>;
  deleteProvider: (id: string) => Promise<boolean>;

  addModel: (providerId: string, name: string) => Promise<boolean>;
  deleteModel: (providerId: string, modelId: string) => Promise<boolean>;
  toggleModelCapability: (providerId: string, modelId: string, cap: ModelCapability) => Promise<boolean>;
  setProviderModels: (providerId: string, models: { name: string; capabilities: ModelCapability[] }[]) => Promise<boolean>;
  fetchModels: (providerId: string) => Promise<{ success: boolean; error?: string }>;
  fetchPresets: () => Promise<void>;
}

export const useModelStore = create<ModelState>((set, get) => ({
  providers: [],
  presets: [],
  modelParamsCache: {},
  initialized: false,
  initializeFailed: false,

  initialize: async () => {
    if (get().initialized) return;
    try {
      const providers = await modelApi.fetchProviders<ModelProvider[]>();
      if (!Array.isArray(providers)) throw new Error("unexpected providers payload");
      // API 返回 camelCase，与前端 ModelProvider 类型一致，直接使用
      set({ providers, initialized: true, initializeFailed: false });
      await get().fetchPresets();
      // 拉取模型参数配置（fields 为唯一数据源）
      try {
        const params = await modelApi.fetchModelParams<ModelParamsMap>();
        if (isRecord(params)) set({ modelParamsCache: params });
      } catch {
        // 模型参数拉取失败不阻塞
      }
    } catch {
      // 失败不置 initialized：与「已初始化（空列表）」区分，后续调用 initialize() 可重试
      set({ initializeFailed: true });
    }
  },

  findModelParams: (providerId: string, modelName: string, capability: string) => {
    const cache = get().modelParamsCache;
    // 由 providerId 找到 baseUrl 并解析 host（用于上游通配匹配）
    const provider = get().providers.find((c) => c.id === providerId);
    const host = provider?.baseUrl ? hostFromBaseUrl(provider.baseUrl) : "";
    // 1. host 通配第一个命中 → 该 host 下模型名精确 > 通配
    if (host) {
      for (const [hostPattern, models] of Object.entries(cache)) {
        if (hostPattern === "_default" || !models) continue;
        if (!patternToRegex(hostPattern).test(host)) continue;
        const modelMap = models as Record<string, Record<string, ModelParamConfig>>;
        // 模型名精确优先。
        // 后端下发前已把各条目与 _default 按字段合并（fields 必完整），此处
        // Array.isArray 校验仅作防御：下发链路异常时宁可回退 _default 也不渲染空字段。
        const exact = modelMap[modelName]?.[capability];
        if (Array.isArray(exact?.fields)) return exact;
        for (const [mPattern, caps] of Object.entries(modelMap)) {
          if (patternToRegex(mPattern).test(modelName)) {
            const match = caps[capability];
            if (Array.isArray(match?.fields)) return match;
          }
        }
        break; // host 已命中，不再继续
      }
    }
    // 2. _default 兜底（纯透传）
    const defCaps = cache["_default"] as Record<string, ModelParamConfig> | undefined;
    const def = defCaps?.[capability];
    return Array.isArray(def?.fields) ? def : null;
  },

  fetchPresets: async () => {
    try {
      const presets = await modelApi.fetchPresets<ProviderPreset[]>();
      if (Array.isArray(presets)) set({ presets });
    } catch {
      // 预设拉取失败不阻塞：下拉为空，用户手敲 base_url
    }
  },

  addProvider: async (name, baseUrl, apiKey, protocol) => {
    let data: { id: string };
    try {
      data = await modelApi.createProvider(name, baseUrl, apiKey, protocol);
    } catch (e) {
      notifyFailure(e, "model_config.provider_add_failed");
      return false;
    }
    const provider: ModelProvider = { id: data.id, name, baseUrl: baseUrl.replace(/\/$/, ""), apiKey: apiKey, models: [] };
    if (protocol) provider.protocol = protocol;
    set((s) => ({ providers: [...s.providers, provider] }));
    return true;
  },

  updateProvider: async (id, patch) => {
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.baseUrl !== undefined) body.baseUrl = patch.baseUrl;
    if (patch.apiKey !== undefined) body.apiKey = patch.apiKey;
    if (patch.protocol !== undefined) body.protocol = patch.protocol;
    // 校验业务结果：此前无论成败都合并本地状态，UI 还提示「已更新」
    try {
      await modelApi.updateProvider(id, body);
    } catch (e) {
      notifyFailure(e, "model_config.provider_update_failed");
      return false;
    }
    // 只合并非 undefined 的字段，避免 undefined 覆盖原有值
    set((s) => ({
      providers: s.providers.map((c) => {
        if (c.id !== id) return c;
        const merged = { ...c };
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
        }
        return merged;
      }),
    }));
    return true;
  },

  fetchProviderApiKey: async (id) => {
    try {
      const data = await modelApi.fetchProviderApiKey(id);
      return data.apiKey;
    } catch (e) {
      throw new Error(
        e instanceof ApiError
          ? e.message
          : resolveApiError(null, undefined, "model_config.api_key_fetch_failed")
      );
    }
  },

  deleteProvider: async (id) => {
    try {
      await modelApi.deleteProvider(id);
    } catch (e) {
      notifyFailure(e, "model_config.provider_delete_failed");
      return false;
    }
    set((s) => ({ providers: s.providers.filter((c) => c.id !== id) }));
    return true;
  },

  addModel: async (providerId, name) => {
    let data: { id: string };
    try {
      data = await modelApi.addModel(providerId, name);
    } catch (e) {
      notifyFailure(e, "model_config.model_add_failed");
      return false;
    }
    set((s) => ({
      providers: s.providers.map((c) =>
        c.id === providerId ? { ...c, models: [...c.models, { id: data.id, name, capabilities: [] }] } : c
      ),
    }));
    return true;
  },

  deleteModel: async (providerId, modelId) => {
    // 失败不动本地：行还在列表里，用户可重试（失败原因由 store 统一提示）
    try {
      await modelApi.deleteModel(providerId, modelId);
    } catch (e) {
      notifyFailure(e, "model_config.model_delete_failed");
      return false;
    }
    set((s) => ({
      providers: s.providers.map((c) =>
        c.id === providerId ? { ...c, models: c.models.filter((m) => m.id !== modelId) } : c
      ),
    }));
    return true;
  },

  toggleModelCapability: async (providerId, modelId, cap) => {
    const providers = get().providers;
    const ch = providers.find((c) => c.id === providerId);
    if (!ch) return false;
    const model = ch.models.find((m) => m.id === modelId);
    if (!model) return false;
    const has = model.capabilities?.includes(cap);
    const caps = has ? (model.capabilities || []).filter((x) => x !== cap) : [...(model.capabilities || []), cap];

    // 失败不动本地：此前先写后忘，勾选看起来生效、刷新就回滚
    try {
      await modelApi.setModelCapability(providerId, modelId, caps);
    } catch (e) {
      notifyFailure(e, "model_config.model_capability_failed");
      return false;
    }
    set((s) => ({
      providers: s.providers.map((c) =>
        c.id === providerId ? {
          ...c,
          models: c.models.map((m) => (m.id === modelId ? { ...m, capabilities: caps } : m)),
        } : c
      ),
    }));
    return true;
  },

  setProviderModels: async (providerId, models) => {
    try {
      await modelApi.setProviderModels(providerId, models);
    } catch (e) {
      notifyFailure(e, "model_config.models_set_failed");
      return false;
    }
    // 就地更新本地：写入成功但重拉列表失败时，保证勾选结果与服务端一致
    const applyLocally = () => {
      set((s) => ({
        providers: s.providers.map((c) => {
          if (c.id !== providerId) return c;
          const idByName = new Map(c.models.map((m) => [m.name, m.id]));
          return {
            ...c,
            models: models.map((m) => ({
              id: idByName.get(m.name) ?? m.name,
              name: m.name,
              capabilities: m.capabilities,
            })),
          };
        }),
      }));
    };
    let reload: ModelProvider[];
    try {
      reload = await modelApi.fetchProviders<ModelProvider[]>();
    } catch {
      // 写入已成功，只是重新拉取列表失败：不能算写失败（那会让 UI 提示与事实相反）
      applyLocally();
      return true;
    }
    if (Array.isArray(reload)) {
      set({ providers: reload });
      return true;
    }
    applyLocally();
    return true;
  },

  fetchModels: async (providerId) => {
    const ch = get().providers.find((c) => c.id === providerId);
    if (!ch) {
      return fetchModelsFailure(i18n.t("error.models.provider_not_found_in_store"));
    }
    if (!ch.baseUrl) {
      return fetchModelsFailure(i18n.t("error.models.provider_no_base_url"));
    }
    try {
      const res = await modelApi.fetchModelsList(providerId);

      // 先尝试解析响应体——网关异常时可能是 HTML 而非 JSON，需兜底
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      const errorBody = parseErrorBody(json);

      // ① HTTP 非 2xx：按服务端错误码取本地化文案，拿不到再退回状态码
      if (!res.ok) {
        // 文案附带请求 ID，便于报障时定位服务端日志
        const msg = resolveApiError(errorBody, res.status, "models.fetch_failed", {
          withRequestId: true,
        });
        console.error("Fetch models failed:", {
          status: res.status,
          statusText: res.statusText,
          body: json,
          msg,
        });
        return fetchModelsFailure(msg);
      }

      // ② 空响应
      if (json === null) {
        return fetchModelsFailure(i18n.t("error.common.empty_response"));
      }

      // ③ 结构异常或业务码非 200
      if (!isRecord(json) || (json as { code?: number }).code !== 200) {
        const msg = resolveApiError(errorBody, undefined, "common.unexpected_response");
        console.error("Fetch models failed:", { status: res.status, body: json, msg });
        return fetchModelsFailure(msg);
      }

      const data = (json as { data?: unknown }).data;
      const fetched: { name: string }[] = Array.isArray(data)
        ? (data as RawModelEntry[]).map((m) => ({ name: (m.id || m.name) as string }))
        : [];
      const fetchedSet = new Set(fetched.map((m) => m.name));
      const existing = ch.models;
      const merged: { name: string; capabilities: ModelCapability[] }[] = [];
      for (const ex of existing) {
        if (fetchedSet.has(ex.name)) {
          merged.push({ name: ex.name, capabilities: ex.capabilities || [] });
        }
      }
      for (const f of fetched) {
        if (!existing.some((e) => e.name === f.name)) {
          merged.push({ name: f.name, capabilities: [] });
        }
      }
      const applied = await get().setProviderModels(providerId, merged);
      // setProviderModels 内部已提示失败原因，这里只把结果透传给调用方
      if (!applied) {
        return fetchModelsFailure(i18n.t("error.model_config.models_set_failed"));
      }
      return { success: true };
    } catch (e: unknown) {
      console.error("Fetch models failed:", e);
      return fetchModelsFailure(e instanceof Error ? e.message : i18n.t("error.unknown"));
    }
  },
}));
