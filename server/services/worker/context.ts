/**
 * Worker 上下文。
 * 从任务记录构建执行上下文，聚合任务配置与参考图、参考音频等资源。
 */

import type { GenerationTask } from "@prisma/client";

export interface WorkerContext {
  task: GenerationTask;
  config: Record<string, unknown>;
  refImages: string[];
  refAudios: string[];
  /** 参考视频，见 GenerationTask.refVideos */
  refVideos: string[];
}

/** 从 Prisma GenerationTask 构建 WorkerContext
 *  CRUD 层已通过 deserializeTask 反序列化 JSON 字段，这里直接使用即可。
 */
export function buildContext(task: GenerationTask): WorkerContext {
  return {
    task,
    config: (task.config as Record<string, unknown>) ?? {},
    refImages: (task.refImages as string[]) ?? [],
    refAudios: (task.refAudios as string[]) ?? [],
    refVideos: (task.refVideos as string[]) ?? [],
  };
}
