import { z } from "zod";
import { toISO } from "./common";

// ── Model Config schemas（对应 backend/app/schemas/model_config.py） ──

export const channelCreateSchema = z.object({
  name: z.string().min(1).max(100),
  base_url: z.string().min(1).max(500),
  api_key: z.string().max(500).optional(),
  protocol: z.string().max(30).optional(),
  config: z.record(z.unknown()).optional(),
});

export const channelUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  base_url: z.string().min(1).max(500).optional(),
  api_key: z.string().max(500).optional(),
  protocol: z.string().max(30).optional(),
  config: z.record(z.unknown()).optional(),
});

export const channelOutSchema = z.object({
  id: z.number(),
  user_id: z.number().nullable(),
  name: z.string(),
  base_url: z.string(),
  api_key: z.string(),
  protocol: z.string(),
  config: z.record(z.unknown()).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ChannelCreate = z.infer<typeof channelCreateSchema>;
export type ChannelUpdate = z.infer<typeof channelUpdateSchema>;
export type ChannelOut = z.infer<typeof channelOutSchema>;

/** 掩码 apiKey：保留前4后4位 */
export function maskApiKey(key: string): string {
  if (!key || key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

/** Prisma camelCase → API snake_case（apiKey 掩码，兼容两种格式） */
export function toChannelOut(channel: {
  id: number;
  userId?: number | null;
  user_id?: number | null;
  name: string;
  baseUrl?: string;
  base_url?: string;
  apiKey?: string;
  api_key?: string;
  protocol: string;
  config: unknown;
  createdAt?: Date | string;
  created_at?: Date | string;
  updatedAt?: Date | string;
  updated_at?: Date | string;
}): ChannelOut {
  const parseJson = (raw: unknown): Record<string, unknown> | null => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch { return null; }
    }
    if (typeof raw === "object") return raw as Record<string, unknown>;
    return null;
  };

  const apiKey = channel.apiKey ?? channel.api_key ?? "";

  return {
    id: channel.id,
    user_id: channel.userId ?? channel.user_id ?? null,
    name: channel.name,
    base_url: channel.baseUrl ?? channel.base_url ?? "",
    api_key: maskApiKey(apiKey),
    protocol: channel.protocol,
    config: parseJson(channel.config),
    created_at: toISO(channel.createdAt ?? channel.created_at) ?? "",
    updated_at: toISO(channel.updatedAt ?? channel.updated_at) ?? "",
  };
}
