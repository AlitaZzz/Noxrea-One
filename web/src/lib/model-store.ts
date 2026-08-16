/**
 * 模型与渠道状态仓库。
 * 管理服务商渠道及其模型清单的增删改、能力标记，
 * 支持从渠道远端拉取模型列表、读取服务商预设与模型参数配置缓存。
 */
import { create } from "zustand";

import { modelApi } from "@/features/settings/api";
import type { ModelCapability, ModelChannel, ModelParamConfig,ProviderPreset } from "@/lib/types/models";

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
  channels: ModelChannel[];
  presets: ProviderPreset[];
  modelParamsCache: ModelParamsMap;
  initialized: boolean;
  initialize: () => Promise<void>;
  findModelParams: (channelId: string, modelName: string, capability: string) => ModelParamConfig | null;

  addChannel: (name: string, baseUrl: string, apiKey: string, protocol?: string) => Promise<void>;
  updateChannel: (id: string, patch: Partial<Pick<ModelChannel, "name" | "baseUrl" | "apiKey" | "protocol">>) => Promise<void>;
  fetchChannelApiKey: (id: string) => Promise<string>;
  deleteChannel: (id: string) => Promise<void>;

  addModel: (channelId: string, name: string) => Promise<void>;
  toggleModelCapability: (channelId: string, modelId: string, cap: ModelCapability) => Promise<void>;
  setChannelModels: (channelId: string, models: { name: string; capabilities: ModelCapability[] }[]) => Promise<void>;
  fetchModels: (channelId: string) => Promise<{ success: boolean; error?: string }>;
  fetchPresets: () => Promise<void>;
}

export const useModelStore = create<ModelState>((set, get) => ({
  channels: [],
  presets: [],
  modelParamsCache: {},
  initialized: false,

  initialize: async () => {
    if (get().initialized) return;
    try {
      const res = await modelApi.fetchChannels<ModelChannel[]>();
      if (res.code === 200 && res.data) {
        // API 返回 camelCase，与前端 ModelChannel 类型一致，直接使用
        set({ channels: res.data, initialized: true });
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

  findModelParams: (channelId: string, modelName: string, capability: string) => {
    const cache = get().modelParamsCache;
    // 由 channelId 找到 baseUrl 并解析 host（用于上游通配匹配）
    const channel = get().channels.find((c) => c.id === channelId);
    const host = channel?.baseUrl ? hostFromBaseUrl(channel.baseUrl) : "";
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

  addChannel: async (name, baseUrl, apiKey, protocol) => {
    const res = await modelApi.createChannel(name, baseUrl, apiKey, protocol);
    if (res.code === 200 && res.data) {
      const channel: ModelChannel = { id: res.data.id, name, baseUrl: baseUrl.replace(/\/$/, ""), apiKey: apiKey, models: [] };
      if (protocol) channel.protocol = protocol;
      set((s) => ({ channels: [...s.channels, channel] }));
    }
  },

  updateChannel: async (id, patch) => {
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.baseUrl !== undefined) body.baseUrl = patch.baseUrl;
    if (patch.apiKey !== undefined) body.apiKey = patch.apiKey;
    if (patch.protocol !== undefined) body.protocol = patch.protocol;
    await modelApi.updateChannel(id, body);
    // 只合并非 undefined 的字段，避免 undefined 覆盖原有值
    set((s) => ({
      channels: s.channels.map((c) => {
        if (c.id !== id) return c;
        const merged = { ...c };
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
        }
        return merged;
      }),
    }));
  },

  fetchChannelApiKey: async (id) => {
    const res = await modelApi.fetchChannelApiKey(id);
    if (res.code === 200 && res.data) {
      return res.data.apiKey;
    }
    throw new Error("Failed to fetch API key");
  },

  deleteChannel: async (id) => {
    await modelApi.deleteChannel(id);
    set((s) => ({ channels: s.channels.filter((c) => c.id !== id) }));
  },

  addModel: async (channelId, name) => {
    const res = await modelApi.addModel(channelId, name);
    if (res.code === 200 && res.data) {
      set((s) => ({
        channels: s.channels.map((c) =>
          c.id === channelId ? { ...c, models: [...c.models, { id: res.data.id, name, capabilities: [] }] } : c
        ),
      }));
    }
  },

  toggleModelCapability: async (channelId, modelId, cap) => {
    const channels = get().channels;
    const ch = channels.find((c) => c.id === channelId);
    if (!ch) return;
    const model = ch.models.find((m) => m.id === modelId);
    if (!model) return;
    const has = model.capabilities?.includes(cap);
    const caps = has ? (model.capabilities || []).filter((x) => x !== cap) : [...(model.capabilities || []), cap];

    await modelApi.setModelCapability(channelId, modelId, caps);
    set((s) => ({
      channels: s.channels.map((c) =>
        c.id === channelId ? {
          ...c,
          models: c.models.map((m) => (m.id === modelId ? { ...m, capabilities: caps } : m)),
        } : c
      ),
    }));
  },

  setChannelModels: async (channelId, models) => {
    await modelApi.setChannelModels(channelId, models);
    const reload = await modelApi.fetchChannels<ModelChannel[]>();
    if (reload.code === 200 && reload.data) {
      set({ channels: reload.data });
    }
  },

  fetchModels: async (channelId) => {
      const ch = get().channels.find((c) => c.id === channelId);
    if (!ch) {
      console.error("Channel not found in store");
      return { success: false, error: "Channel not found in store" };
    }
    if (!ch.baseUrl) {
      console.error("Channel has no baseUrl configured");
      return { success: false, error: "Channel has no baseUrl configured. Please update the channel URL." };
    }
    try {
      const res = await modelApi.fetchModelsList(channelId);
      const json = await res.json();
      if (json.code !== 200) {
        const msg = json.msg || `HTTP ${res.status}`;
        console.error("Fetch models failed:", msg);
        return { success: false, error: msg };
      }
      const fetched: { name: string }[] = (json.data || []).map(
        (m: RawModelEntry) => ({ name: (m.id || m.name) as string })
      );
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
      await get().setChannelModels(channelId, merged);
      return { success: true };
    } catch (e: unknown) {
      console.error("Fetch models failed:", e);
      return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
    }
  },
}));
