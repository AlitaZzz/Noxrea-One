/**
 * 模型配置相关校验模式。
 * 定义模型信息创建、批量设置与能力更新的 zod 校验规则。
 */
import { z } from "zod";

// Model Info schemas

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

// 批量设置模型

export const batchSetModelsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1).max(200),
      capabilities: z.array(z.string()).optional(),
    })
  ),
});

export type BatchSetModels = z.infer<typeof batchSetModelsSchema>;

// 更新模型能力

export const updateCapabilitySchema = z.object({
  capabilities: z.array(z.string()),
});

export type UpdateCapability = z.infer<typeof updateCapabilitySchema>;
