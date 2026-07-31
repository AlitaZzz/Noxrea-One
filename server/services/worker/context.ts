// ── Worker 上下文（对应 backend/app/services/worker/context.py） ──

import { getConfig } from "@server/core/config";
import type { GenerationTask } from "@prisma/client";

export interface WorkerContext {
  task: GenerationTask;
  config: Record<string, unknown>;
  refImages: string[];
}

/** 从 Prisma GenerationTask 构建 WorkerContext */
export function buildContext(task: GenerationTask): WorkerContext {
  let config: Record<string, unknown> = {};
  let refImages: string[] = [];

  try {
    config = task.config ? JSON.parse(task.config) : {};
  } catch {
    // ignore
  }

  try {
    refImages = task.refImages ? JSON.parse(task.refImages) : [];
  } catch {
    // ignore
  }

  return { task, config, refImages };
}
