import { create } from "zustand";
import type { ModelChannel, ModelCapability, ProviderPreset } from "@/lib/types";
import { api, getTokenHeader, BASE } from "@/lib/api";

interface ModelState {
  channels: ModelChannel[];
  presets: ProviderPreset[];
  initialized: boolean;
  initialize: () => Promise<void>;

  addChannel: (name: string, baseUrl: string, apiKey: string) => Promise<void>;
  updateChannel: (id: string, patch: Partial<Pick<ModelChannel, "name" | "baseUrl" | "apiKey">>) => Promise<void>;
  deleteChannel: (id: string) => Promise<void>;

  addModel: (channelId: string, name: string) => Promise<void>;
  toggleModelCapability: (channelId: string, modelId: string, cap: ModelCapability) => Promise<void>;
  setChannelModels: (channelId: string, models: { name: string; capabilities: ModelCapability[] }[]) => Promise<void>;
  fetchModels: (channelId: string) => Promise<void>;
  fetchPresets: () => Promise<void>;
}

export const useModelStore = create<ModelState>((set, get) => ({
  channels: [],
  presets: [],
  initialized: false,

  initialize: async () => {
    if (get().initialized) return;
    try {
      const res = await api<any[]>("/api/model-config/channels");
      if (res.code === 200 && res.data) {
        set({ channels: res.data, initialized: true });
        await get().fetchPresets();
        return;
      }
    } catch {}
    set({ initialized: true });
  },

  fetchPresets: async () => {
    try {
      const res = await api<ProviderPreset[]>("/api/model-config/presets");
      if (res.code === 200 && res.data) {
        set({ presets: res.data });
      }
    } catch {
      // 预设拉取失败不阻塞：下拉为空，用户手敲 baseUrl
    }
  },

  addChannel: async (name, baseUrl, apiKey) => {
    const res = await api<{ id: string }>("/api/model-config/channels", {
      method: "POST",
      body: JSON.stringify({ name, baseUrl: baseUrl.replace(/\/$/, ""), apiKey }),
    });
    if (res.code === 200 && res.data) {
      const channel: ModelChannel = { id: res.data.id, name, baseUrl: baseUrl.replace(/\/$/, ""), apiKey, models: [] };
      set((s) => ({ channels: [...s.channels, channel] }));
    }
  },

  updateChannel: async (id, patch) => {
    await api(`/api/model-config/channels/${id}`, { method: "PUT", body: JSON.stringify(patch) });
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
    // 全量提交（models/set = delete all + insert），用于批量勾选 / 增量合并
    await api(`/api/model-config/channels/${channelId}/models/set`, {
      method: "POST", body: JSON.stringify({ models }),
    });
    // 后端 set_models 不返回带 id 的模型，重载 channels 拿回完整数据（含 id）
    const reload = await api<any[]>("/api/model-config/channels");
    if (reload.code === 200 && reload.data) {
      set({ channels: reload.data });
    }
  },

  fetchModels: async (channelId) => {
    const ch = get().channels.find((c) => c.id === channelId);
    if (!ch || !ch.baseUrl) return;
    try {
      const res = await fetch(`${BASE}/api/models/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getTokenHeader() },
        body: JSON.stringify({ channelId }),
      });
      const json = await res.json();
      if (json.code !== 200) throw new Error(json.msg || `HTTP ${res.status}`);
      const fetched: { name: string }[] = (json.data || []).map((m: any) => ({ name: m.id || m.name }));
      const fetchedNames = new Set(fetched.map((m) => m.name));
      const existing = ch.models;
      // 增量合并：已存在的保留用户调过的 capabilities，新模型默认不启用（空 capabilities，进"可用"），上游删的丢弃
      const merged: { name: string; capabilities: ModelCapability[] }[] = [];
      for (const ex of existing) {
        if (fetchedNames.has(ex.name)) {
          merged.push({ name: ex.name, capabilities: ex.capabilities || [] });
        }
      }
      for (const f of fetched) {
        if (!existing.some((e) => e.name === f.name)) {
          merged.push({ name: f.name, capabilities: [] });
        }
      }
      await get().setChannelModels(channelId, merged);
    } catch (e) { console.error("Fetch models failed:", e); throw e; }
  },
}));
