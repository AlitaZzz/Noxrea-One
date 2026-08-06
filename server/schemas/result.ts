/**
 * 生成结果校验模式。
 * 定义同步生成结果与异步提交结果的 zod 校验规则。
 */
import { z } from "zod";

// 同步生成结果
export const generationResultSchema = z.object({
  urls: z.array(z.string()),
  text: z.string().optional(),
});

// 异步提交结果
export const asyncSubmissionSchema = z.object({
  upstreamTaskId: z.string(),
  status: z.string(),
});

// 轮询结果
export const pollResultSchema = z.object({
  status: z.string(),
  urls: z.array(z.string()).optional(),
  text: z.string().optional(),
  error: z.string().optional(),
});

export type GenerationResult = z.infer<typeof generationResultSchema>;
export type AsyncSubmission = z.infer<typeof asyncSubmissionSchema>;
export type PollResult = z.infer<typeof pollResultSchema>;
