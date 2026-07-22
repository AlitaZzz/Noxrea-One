import { create } from "zustand";
import type { ModelChannel, ModelInfo, ModelCapability } from "@/lib/types";
import { api, getTokenHeader, BASE } from "@/lib/api";

function guessCapabilities(name: string): ModelCapability[] {
  const lower = name.toLowerCase();
  const caps: ModelCapability[] = [];
  if (/dall-e|flux|stable.?diffusion|sd[-_.]|midjourney|imagen|playground|image/.test(lower)) caps.push("image");
  if (/sora|runway|pika|video|gen-?[23]|kling|hailuo/.test(lower)) caps.push("video");
  if (/whisper|tts|audio|speech|voice|elevenlabs|sonic/.test(lower)) caps.push("audio");
  if (/gpt|claude|gemini|llama|qwen|deepseek|mistral|mixtral|command|phi|yi|chat|instruct|text/.test(lower)) caps.push("text");
  if (caps.length === 0) caps.push("text");
  return caps;
}

interface ModelState {
  channels: ModelChannel[];
  initialized: boolean;
  initialize: () => Promise<void>;

  addChannel: (name: string, baseUrl: string, apiKey: string) => Promise<void>;
  updateChannel: (id: string, patch: Partial<Pick<ModelChannel, "name" | "baseUrl" | "apiKey">>) => Promise<void>;
  deleteChannel: (id: string) => Promise<void>;

  addModel: (channelId: string, name: string) => Promise<void>;
  toggleModelCapability: (channelId: string, modelId: string, cap: ModelCapability) => Promise<void>;
  fetchModels: (channelId: string) => Promise<void>;
}

export const useModelStore = create<ModelState>((set, get) => ({
  channels: [],
  initialized: false,

  initialize: async () => {
    if (get().initialized) return;
    try {
      const res = await api<any[]>("/api/model-config/channels");
      if (res.code === 200 && res.data) {
        set({ channels: res.data, initialized: true });
        return;
      }
    } catch {}
    set({ initialized: true });
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
      body: JSON.stringify({ name, capabilities: guessCapabilities(name) }),
    });
    if (res.code === 200 && res.data) {
      set((s) => ({
        channels: s.channels.map((c) =>
          c.id === channelId ? { ...c, models: [...c.models, { id: res.data.id, name, capabilities: guessCapabilities(name) }] } : c
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
      const models: { name: string; capabilities: ModelCapability[] }[] = (json.data || []).map((m: any) => ({
        name: m.id || m.name,
        capabilities: guessCapabilities(m.id || m.name),
      }));
      // Save fetched models via API
      await api(`/api/model-config/channels/${channelId}/models/set`, {
        method: "POST", body: JSON.stringify({ models }),
      });
      // Reload channels
      const reload = await api<any[]>("/api/model-config/channels");
      if (reload.code === 200 && reload.data) {
        set({ channels: reload.data });
      }
    } catch (e) { console.error("Fetch models failed:", e); throw e; }
  },
}));
