/**
 * 生成任务（视频 / 文本 / 图片）相关 API 封装。
 * 提交、取消与流式监听共用 /api/generate/task 端点，按 type 区分业务。
 */
import type { ApiResult } from "@/lib/api/client";
import { api, apiRaw, apiStream } from "@/lib/api/client";
import type { TaskStatus } from "@/lib/types/canvas";

export interface SubmitGenerationTaskBody {
  type: "video" | "image" | "llm";
  prompt: string;
  model: string;
  providerId: string;
  nodeId: string;
  // image / video 业务字段（llm 无这些 UI 参数）
  quality?: string;
  resolution?: string;
  ratio?: string;
  n?: number;
  // 任务级参考图：image 直接映射上游字段；llm 由 service 归一化注入 messages
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

/**
 * 任务终态事件（SSE 推送与批量对账共用同一结构，字段由服务端
 * toTaskPayload 统一映射，见 server/http/routes/generate.ts）。
 */
export interface TaskStatusEvent {
  taskId: string;
  status: TaskStatus;
  resultUrls?: string[];
  /** 与 resultUrls 逐位对齐的产物大小（字节），服务端 stat 落盘文件得出，缺失为 null */
  resultSizes?: Array<number | null>;
  resultText?: string;
  error?: string;
  errorCode?: string;
  prompt?: string;
  config?: unknown;
}

/** 终态判断的单一谓词：SSE 推送与批量对账共用，避免字面量逐处漂移 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** 批量查询任务状态（对账兜底：页面重新可见 / 网络恢复时调用）。 */
export async function fetchTasksStatus(taskIds: string[]): Promise<ApiResult<TaskStatusEvent[]>> {
  return api<TaskStatusEvent[]>("/api/generate/tasks/batch-status", {
    method: "POST",
    body: JSON.stringify({ ids: taskIds }),
  });
}

/** 生成任务接口命名空间，按业务聚合上述函数。 */
export const generationApi = {
  submitGenerationTask,
  cancelGenerationTask,
  streamGenerationTask,
  fetchTasksStatus,
};
