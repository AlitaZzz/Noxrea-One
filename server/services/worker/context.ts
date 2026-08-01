// ── Worker 上下文（对应 backend/app/services/worker/context.py） ──

import type { GenerationTask } from "@prisma/client";

export interface WorkerContext {
  task: GenerationTask;
  config: Record<string, unknown>;
  refImages: string[];
}

/** 从 Prisma GenerationTask 构建 WorkerContext
 *  CRUD 层已通过 deserializeTask 反序列化 JSON 字段，这里直接使用即可。
 */
export function buildContext(task: GenerationTask): WorkerContext {
  return {
    task,
    config: (task.config as Record<string, unknown>) ?? {},
    refImages: (task.refImages as string[]) ?? [],
  };
}
