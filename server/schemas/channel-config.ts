import { z } from "zod";

// ── Channel Config schemas（对应 backend/app/schemas/channel_config.py） ──

// 协议配置段
export const protocolConfigSchema = z.object({
  type: z.string(),
  image_endpoint: z.string().optional(),
  video_endpoint: z.string().optional(),
  llm_endpoint: z.string().optional(),
  audio_endpoint: z.string().optional(),
  headers: z.record(z.string()).optional(),
  extra_body: z.record(z.unknown()).optional(),
});

// 请求配置段
export const requestConfigSchema = z.object({
  params: z.record(z.unknown()).optional(),
  endpoints: z.record(z.string()).optional(),
  body: z.record(z.unknown()).optional(),
});

// 渠道完整配置（三段结构）
export const channelConfigSchema = z.object({
  params: z.record(z.unknown()).optional(),
  endpoints: z.record(z.string()).optional(),
  body: z.record(z.unknown()).optional(),
  protocols: z.array(protocolConfigSchema).optional(),
});

export type ChannelConfig = z.infer<typeof channelConfigSchema>;
export type ProtocolConfig = z.infer<typeof protocolConfigSchema>;
export type RequestConfig = z.infer<typeof requestConfigSchema>;

// ── Model Info schemas ──

export const modelInfoCreateSchema = z.object({
  name: z.string().min(1).max(200),
  capabilities: z.array(z.string()).optional(),
});

export const modelInfoOutSchema = z.object({
  id: z.number(),
  channelId: z.number(),
  name: z.string(),
  capabilities: z.array(z.string()),
  createdAt: z.string(),
});

export type ModelInfoCreate = z.infer<typeof modelInfoCreateSchema>;
export type ModelInfoOut = z.infer<typeof modelInfoOutSchema>;

// ── 批量设置模型 ──

export const batchSetModelsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1).max(200),
      capabilities: z.array(z.string()).optional(),
    })
  ),
});

export type BatchSetModels = z.infer<typeof batchSetModelsSchema>;

// ── 更新模型能力 ──

export const updateCapabilitySchema = z.object({
  capabilities: z.array(z.string()),
});

export type UpdateCapability = z.infer<typeof updateCapabilitySchema>;
