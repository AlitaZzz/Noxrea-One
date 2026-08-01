import { create } from "zustand";

import { api, BASE,getTokenHeader } from "@/lib/api";
import type { ModelCapability, ModelChannel, ProviderPreset, ModelParamConfig } from "@/lib/types";

interface RawModelEntry {
  id?: string;
  name?: string;
  suggestedCapabilities?: string[];
}

interface ModelState {
  channels: ModelChannel[];
  presets: ProviderPreset[];
  modelParamsCache: Record<string, Record<string, ModelParamConfig>>;
  initialized: boolean;
  initialize: () => Promise<void>;
  findModelParams: (modelName: string, capability: string) => ModelParamConfig | null;

  addChannel: (name: string, baseUrl: string, apiKey: string, protocol?: string, config?: Record<string, unknown>) => Promise<void>;
  updateChannel: (id: string, patch: Partial<Pick<ModelChannel, "name" | "baseUrl" | "apiKey" | "protocol" | "config">>) => Promise<void>;
  deleteChannel: (id: string) => Promise<void>;

  addModel: (channelId: string, name: string) => Promise<void>;
  toggleModelCapability: (channelId: string, modelId: string, cap: ModelCapability) => Promise<void>;
  setChannelModels: (channelId: string, models: { name: string; capabilities: ModelCapability[]; inferredCapabilities?: ModelCapability[] }[]) => Promise<void>;
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
      const res = await api<ModelChannel[]>("/api/model-config/channels");
      if (res.code === 200 && res.data) {
        // API 返回 camelCase，与前端 ModelChannel 类型一致，直接使用
        set({ channels: res.data, initialized: true });
        await get().fetchPresets();
        // 拉取模型参数配置（params + defaults + constraints）
        try {
          const mpRes = await api<Record<string, Record<string, ModelParamConfig>>>("/api/model-params");
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

  findModelParams: (modelName: string, capability: string) => {
    const cache = get().modelParamsCache;
    // 1. 精确匹配
    const exact = cache[modelName]?.[capability];
    if (exact) return exact;
    // 2. 通配符匹配
    for (const [pattern, caps] of Object.entries(cache)) {
      if (pattern === "_default" || pattern === modelName) continue;
      if (pattern.includes("*") || pattern.includes("?")) {
        const regex = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
        if (regex.test(modelName)) {
          const match = caps[capability];
          if (match) return match;
        }
      }
    }
    // 3. _default 兜底
    const def = cache["_default"]?.[capability];
    return def || null;
  },

  fetchPresets: async () => {
    try {
      const res = await api<ProviderPreset[]>("/api/model-config/presets");
      if (res.code === 200 && res.data) {
        set({ presets: res.data });
      }
    } catch {
      // 预设拉取失败不阻塞：下拉为空，用户手敲 base_url
    }
  },

  addChannel: async (name, baseUrl, apiKey, protocol, config) => {
    const body: Record<string, unknown> = { name, baseUrl: baseUrl.replace(/\/$/, ""), apiKey: apiKey };
    if (protocol) body.protocol = protocol;
    if (config) body.config = config;
    const res = await api<{ id: string }>("/api/model-config/channels", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (res.code === 200 && res.data) {
      const channel: ModelChannel = { id: res.data.id, name, baseUrl: baseUrl.replace(/\/$/, ""), apiKey: apiKey, models: [] };
      if (protocol) channel.protocol = protocol;
      if (config) channel.config = config;
      set((s) => ({ channels: [...s.channels, channel] }));
    }
  },

  updateChannel: async (id, patch) => {
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.baseUrl !== undefined) body.baseUrl = patch.baseUrl;
    if (patch.apiKey !== undefined) body.apiKey = patch.apiKey;
    if (patch.protocol !== undefined) body.protocol = patch.protocol;
    if (patch.config !== undefined) body.config = patch.config;
    await api(`/api/model-config/channels/${id}`, { method: "PUT", body: JSON.stringify(body) });
    set((s) => ({ channels: s.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  },

  deleteChannel: async (id) => {
    await api(`/api/model-config/channels/${id}`, { method: "DELETE" });
    set((s) => ({ channels: s.channels.filter((c) => c.id !== id) }));
  },

  addModel: async (channelId, name) => {
    const res = await api<{ id: string }>(`/api/model-config/channels/${channelId}/models`, {
      method: "POST",
      body: JSON.stringify({ name, capabilities: [] }),
    });
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

    await api(`/api/model-config/channels/${channelId}/models/${modelId}/capability`, {
      method: "PUT", body: JSON.stringify({ capabilities: caps }),
    });
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
    await api(`/api/model-config/channels/${channelId}/models/set`, {
      method: "POST", body: JSON.stringify({ models }),
    });
    const reload = await api<ModelChannel[]>("/api/model-config/channels");
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
      const res = await fetch(`${BASE}/api/models/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getTokenHeader() },
        body: JSON.stringify({ channelId: channelId }),
      });
      const json = await res.json();
      if (json.code !== 200) {
        const msg = json.msg || `HTTP ${res.status}`;
        console.error("Fetch models failed:", msg);
        return { success: false, error: msg };
      }
      const fetched: { name: string; suggested: ModelCapability[] }[] = (
        json.data || []
      ).map((m: RawModelEntry) => ({
        name: (m.id || m.name) as string,
        suggested: ((m.suggestedCapabilities || []) as string[]).filter((c) =>
          ["text", "image", "video", "audio"].includes(c)
        ) as ModelCapability[],
      }));
      const fetchedSet = new Set(fetched.map((m) => m.name));
      const existing = ch.models;
      const merged: {
        name: string;
        capabilities: ModelCapability[];
        inferredCapabilities: ModelCapability[];
      }[] = [];
      for (const ex of existing) {
        if (fetchedSet.has(ex.name)) {
          const sug = fetched.find((f) => f.name === ex.name)?.suggested || [];
          merged.push({ name: ex.name, capabilities: ex.capabilities || [], inferredCapabilities: sug });
        }
      }
      for (const f of fetched) {
        if (!existing.some((e) => e.name === f.name)) {
          merged.push({ name: f.name, capabilities: [], inferredCapabilities: f.suggested });
        }
      }
      await get().setChannelModels(channelId, merged);
      return { success: true };
    } catch (e: any) {
      console.error("Fetch models failed:", e);
      return { success: false, error: e?.message ?? "Unknown error" };
    }
  },
}));
