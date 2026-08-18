/**
 * 模型配置相关请求校验模式。
 * 定义供应商与模型配置的创建、更新等入参的 zod 校验规则。
 */
import { z } from "zod";

export const providerCreateSchema = z.object({
  name: z.string().min(1).max(100),
  baseUrl: z.string().min(1).max(500),
  apiKey: z.string().max(500).optional(),
  protocol: z.string().max(30).optional(),
});

export const providerUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  baseUrl: z.string().min(1).max(500).optional(),
  apiKey: z.string().max(500).optional(),
  protocol: z.string().max(30).optional(),
});

export const providerOutSchema = z.object({
  id: z.number(),
  userId: z.number().nullable(),
  name: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  protocol: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProviderCreate = z.infer<typeof providerCreateSchema>;
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;
export type ProviderOut = z.infer<typeof providerOutSchema>;

/** 掩码 apiKey：保留前4后4位，中间用等长 * 填充，保持原始长度 */
export function maskApiKey(key: string): string {
  if (!key || key.length <= 8) return "********";
  const head = key.slice(0, 4);
  const tail = key.slice(-4);
  const stars = "*".repeat(key.length - 8);
  return head + stars + tail;
}
