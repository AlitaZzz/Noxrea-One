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
  refAudios: z.array(z.string()).optional(),
  refVideos: z.array(z.string()).optional(),
  nodeId: z.string().optional(),
  // --- 白名单生成参数 ---
  resolution: z.string().optional(),
  ratio: z.string().optional(),
  quality: z.string().optional(),
  n: z.number().int().min(1).max(4).optional(),
  strength: z.number().optional(),
  seed: z.number().int().optional(),
  background: z.string().optional(),
  seconds: z.number().optional(),
  frame_rate: z.number().optional(),
  // --- LLM 参数 ---
  messages: z.array(z.unknown()).optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  // --- 音频/视频参数 ---
  mode: z.string().optional(),
  input: z.string().optional(),
  voice: z.string().optional(),
  audio_file: z.string().optional(),
  references: z.array(z.string()).optional(),
  refMode: z.string().optional(),
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
  refAudios: z.array(z.string()).nullable(),
  refVideos: z.array(z.string()).nullable(),
  resultUrls: z.array(z.string()).nullable(),
  resultText: z.string().nullable(),
  error: z.string().nullable(),
  nodeId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TaskCreate = z.infer<typeof taskCreateSchema>;
export type TaskOut = z.infer<typeof taskOutSchema>;
