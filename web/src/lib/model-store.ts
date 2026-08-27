/**
 * 模型与供应商状态仓库。
 * 管理供应商及其模型清单的增删改、能力标记，
 * 支持从供应商远端拉取模型列表、读取服务商预设与模型参数配置缓存。
 */
import { create } from "zustand";

import { modelApi } from "@/features/settings/api";
import type { ModelCapability, ModelProvider, ModelParamConfig,ProviderPreset } from "@/lib/types/models";

/** 从 baseUrl 解析 host（供上游通配匹配用） */
function hostFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
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
  initialized: boolean;
  initialize: () => Promise<void>;
  findModelParams: (providerId: string, modelName: string, capability: string) => ModelParamConfig | null;

  addProvider: (name: string, baseUrl: string, apiKey: string, protocol?: string) => Promise<void>;
  updateProvider: (id: string, patch: Partial<Pick<ModelProvider, "name" | "baseUrl" | "apiKey" | "protocol">>) => Promise<void>;
  fetchProviderApiKey: (id: string) => Promise<string>;
  deleteProvider: (id: string) => Promise<void>;

  addModel: (providerId: string, name: string) => Promise<void>;
  toggleModelCapability: (providerId: string, modelId: string, cap: ModelCapability) => Promise<void>;
  setProviderModels: (providerId: string, models: { name: string; capabilities: ModelCapability[] }[]) => Promise<void>;
  fetchModels: (providerId: string) => Promise<{ success: boolean; error?: string }>;
  fetchPresets: () => Promise<void>;
}

export const useModelStore = create<ModelState>((set, get) => ({
  providers: [],
  presets: [],
  modelParamsCache: {},
  initialized: false,

  initialize: async () => {
    if (get().initialized) return;
    try {
      const res = await modelApi.fetchProviders<ModelProvider[]>();
      if (res.code === 200 && res.data) {
        // API 返回 camelCase，与前端 ModelProvider 类型一致，直接使用
        set({ providers: res.data, initialized: true });
        await get().fetchPresets();
        // 拉取模型参数配置（fields 为唯一数据源）
        try {
          const mpRes = await modelApi.fetchModelParams<ModelParamsMap>();
          if (mpRes.code === 200 && mpRes.data) {
            set({ modelParamsCache: mpRes.data });
          }
        } catch {
          // 模型参数拉取失败不阻塞
        }
        return;
      }
    } catch {}
    set({ initialized: true });
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
        const hostRegex = new RegExp("^" + hostPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
        if (hostRegex.test(host)) {
          const modelMap = models as Record<string, Record<string, ModelParamConfig>>;
          // 模型名精确优先
          const exact = modelMap[modelName]?.[capability];
          if (exact) return exact;
          for (const [mPattern, caps] of Object.entries(modelMap)) {
            if (mPattern === "_endpoints") continue;
            if (mPattern.includes("*") || mPattern.includes("?")) {
              const mRegex = new RegExp("^" + mPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
              if (mRegex.test(modelName)) {
                const match = caps[capability];
                if (match) return match;
              }
            }
          }
          break; // host 已命中，不再继续
        }
      }
    }
    // 2. _default 兜底（纯透传）
    const defCaps = cache["_default"] as Record<string, ModelParamConfig> | undefined;
    const def = defCaps?.[capability];
    return def || null;
  },

  fetchPresets: async () => {
    try {
      const res = await modelApi.fetchPresets<ProviderPreset[]>();
      if (res.code === 200 && res.data) {
        set({ presets: res.data });
      }
    } catch {
      // 预设拉取失败不阻塞：下拉为空，用户手敲 base_url
    }
  },

  addProvider: async (name, baseUrl, apiKey, protocol) => {
    const res = await modelApi.createProvider(name, baseUrl, apiKey, protocol);
    if (res.code === 200 && res.data) {
      const provider: ModelProvider = { id: res.data.id, name, baseUrl: baseUrl.replace(/\/$/, ""), apiKey: apiKey, models: [] };
      if (protocol) provider.protocol = protocol;
      set((s) => ({ providers: [...s.providers, provider] }));
    }
  },

  updateProvider: async (id, patch) => {
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.baseUrl !== undefined) body.baseUrl = patch.baseUrl;
    if (patch.apiKey !== undefined) body.apiKey = patch.apiKey;
    if (patch.protocol !== undefined) body.protocol = patch.protocol;
    await modelApi.updateProvider(id, body);
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
  },

  fetchProviderApiKey: async (id) => {
    const res = await modelApi.fetchProviderApiKey(id);
    if (res.code === 200 && res.data) {
      return res.data.apiKey;
    }
    throw new Error("Failed to fetch API key");
  },

  deleteProvider: async (id) => {
    await modelApi.deleteProvider(id);
    set((s) => ({ providers: s.providers.filter((c) => c.id !== id) }));
  },

  addModel: async (providerId, name) => {
    const res = await modelApi.addModel(providerId, name);
    if (res.code === 200 && res.data) {
      set((s) => ({
        providers: s.providers.map((c) =>
          c.id === providerId ? { ...c, models: [...c.models, { id: res.data.id, name, capabilities: [] }] } : c
        ),
      }));
    }
  },

  toggleModelCapability: async (providerId, modelId, cap) => {
    const providers = get().providers;
    const ch = providers.find((c) => c.id === providerId);
    if (!ch) return;
    const model = ch.models.find((m) => m.id === modelId);
    if (!model) return;
    const has = model.capabilities?.includes(cap);
    const caps = has ? (model.capabilities || []).filter((x) => x !== cap) : [...(model.capabilities || []), cap];

    await modelApi.setModelCapability(providerId, modelId, caps);
    set((s) => ({
      providers: s.providers.map((c) =>
        c.id === providerId ? {
          ...c,
          models: c.models.map((m) => (m.id === modelId ? { ...m, capabilities: caps } : m)),
        } : c
      ),
    }));
  },

  setProviderModels: async (providerId, models) => {
    await modelApi.setProviderModels(providerId, models);
    const reload = await modelApi.fetchProviders<ModelProvider[]>();
    if (reload.code === 200 && reload.data) {
      set({ providers: reload.data });
    }
  },

  fetchModels: async (providerId) => {
      const ch = get().providers.find((c) => c.id === providerId);
    if (!ch) {
      console.error("Provider not found in store");
      return { success: false, error: "Provider not found in store" };
    }
    if (!ch.baseUrl) {
      console.error("Provider has no baseUrl configured");
      return { success: false, error: "Provider has no baseUrl configured. Please update the provider URL." };
    }
    try {
      const res = await modelApi.fetchModelsList(providerId);

      // 先尝试解析响应体——网关异常时可能是 HTML 而非 JSON，需兜底
      let json: Record<string, unknown> | null = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }

      // 服务端统一把错误描述放在 detail（fail / onError），msg 仅成功摘要里有
      const detail = (json && (json.msg ?? json.detail)) as string | undefined;

      // ① HTTP 非 2xx：先取 detail，拿不到再用状态码兜底
      if (!res.ok) {
        const msg = detail || `HTTP ${res.status} (${res.statusText})`;
        console.error("Fetch models failed:", {
          status: res.status,
          statusText: res.statusText,
          body: json,
          msg,
        });
        return { success: false, error: msg };
      }

      // ② 结构异常或业务码非 200
      if (!json || json.code !== 200) {
        const msg = detail ?? (json ? "Unknown server response" : "Empty response");
        console.error("Fetch models failed:", {
          status: res.status,
          body: json,
          msg,
        });
        return { success: false, error: msg };
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
      await get().setProviderModels(providerId, merged);
      return { success: true };
    } catch (e: unknown) {
      console.error("Fetch models failed:", e);
      return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
  },
}));
