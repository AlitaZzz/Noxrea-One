/**
 * 任务相关请求校验模式。
 * 定义生成任务创建入参的 zod 校验规则。
 */
import { z } from "zod";

import { fileRefSchema } from "@server/schemas/file-ref";

export const taskCreateSchema = z.object({
  // 模态白名单：与产品能力对齐（音频生成未开放，见 T3 决策）；text 为历史归一化输入
  type: z.enum(["image", "video", "llm", "text"]).optional(),
  model: z.string().max(200).optional(),
  providerId: z.number().int().positive().optional(),
  prompt: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  // 引用值域与资产 fileKey 同一规则（fileRefSchema）：来自画布媒体节点 src
  // （上传 key / 外部 URL）或资产库，data:/blob: 预览形态不入引用
  refImages: z.array(fileRefSchema).optional(),
  refAudios: z.array(fileRefSchema).optional(),
  refVideos: z.array(fileRefSchema).optional(),
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
  // --- 视频参数 ---
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
