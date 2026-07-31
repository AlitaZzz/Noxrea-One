import { z } from "zod";

// ── Result schemas（对应 backend/app/schemas/result.py） ──

// 同步生成结果
export const generationResultSchema = z.object({
  urls: z.array(z.string()),
  text: z.string().optional(),
});

// 异步提交结果
export const asyncSubmissionSchema = z.object({
  upstream_task_id: z.string(),
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
