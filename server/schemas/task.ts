/**
 * 任务相关请求校验模式。
 * 定义生成任务创建入参的 zod 校验规则。
 */
import { z } from "zod";

export const taskCreateSchema = z.object({
  type: z.string().max(30).optional(),
  protocol: z.string().max(30).optional(),
  model: z.string().max(200).optional(),
  channelId: z.number().int().positive().optional(),
  prompt: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  refImages: z.array(z.string()).optional(),
  refAudio: z.array(z.string()).optional(),
  nodeId: z.string().optional(),
});

export const taskOutSchema = z.object({
  id: z.string(),
  userId: z.number(),
  type: z.string(),
  protocol: z.string().nullable(),
  model: z.string().nullable(),
  upstreamTaskId: z.string().nullable(),
  status: z.string(),
  prompt: z.string(),
  config: z.record(z.unknown()),
  refImages: z.array(z.string()).nullable(),
  refAudio: z.array(z.string()).nullable(),
  resultUrls: z.array(z.string()).nullable(),
  resultText: z.string().nullable(),
  error: z.string().nullable(),
  nodeId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TaskCreate = z.infer<typeof taskCreateSchema>;
export type TaskOut = z.infer<typeof taskOutSchema>;
