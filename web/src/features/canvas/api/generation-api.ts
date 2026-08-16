/**
 * 生成任务（视频 / 文本 / 图片）相关 API 封装。
 * 提交、取消与流式监听共用 /api/generate/task 端点，按 type 区分业务。
 */
import { apiRaw, apiStream } from "@/lib/api/client";

export interface SubmitGenerationTaskBody {
  type: "video" | "image" | "llm";
  prompt: string;
  model: string;
  channelId: string;
  nodeId: string;
  // image 业务字段
  quality?: string;
  resolution?: string;
  ratio?: string;
  n?: number;
  refImages?: string[];
  // video 业务字段
  seconds?: number;
  generateAudio?: boolean;
  refAudios?: string[];
  refVideos?: string[];
  refMode?: string;
  // llm 业务字段
  messages?: unknown[];
  stream?: boolean;
}

/** 提交生成任务，返回原始 Response（调用方解析 data.id）。 */
export async function submitGenerationTask(body: SubmitGenerationTaskBody): Promise<Response> {
  return apiRaw("/api/generate/task", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** 取消生成任务（DELETE /api/generate/task/:taskId/cancel）。 */
export async function cancelGenerationTask(taskId: string): Promise<Response> {
  return apiRaw(`/api/generate/task/${taskId}/cancel`, { method: "DELETE" });
}

/** 流式监听生成任务进度（SSE / 分块流）。 */
export async function streamGenerationTask(taskId: string, signal?: AbortSignal): Promise<Response> {
  return apiStream(`/api/generate/task/${taskId}/stream`, { signal });
}

/** 生成任务接口命名空间，按业务聚合上述函数。 */
export const generationApi = {
  submitGenerationTask,
  cancelGenerationTask,
  streamGenerationTask,
};
