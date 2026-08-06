/**
 * 模型配置相关请求校验模式。
 * 定义渠道与模型配置的创建、更新等入参的 zod 校验规则。
 */
import { z } from "zod";

export const channelCreateSchema = z.object({
  name: z.string().min(1).max(100),
  baseUrl: z.string().min(1).max(500),
  apiKey: z.string().max(500).optional(),
  protocol: z.string().max(30).optional(),
  config: z.record(z.unknown()).optional(),
});

export const channelUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  baseUrl: z.string().min(1).max(500).optional(),
  apiKey: z.string().max(500).optional(),
  protocol: z.string().max(30).optional(),
  config: z.record(z.unknown()).optional(),
});

export const channelOutSchema = z.object({
  id: z.number(),
  userId: z.number().nullable(),
  name: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  protocol: z.string(),
  config: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ChannelCreate = z.infer<typeof channelCreateSchema>;
export type ChannelUpdate = z.infer<typeof channelUpdateSchema>;
export type ChannelOut = z.infer<typeof channelOutSchema>;

/** 掩码 apiKey：保留前4后4位 */
export function maskApiKey(key: string): string {
  if (!key || key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
