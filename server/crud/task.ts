import { prisma } from "@server/core/database/client";
import { stringifyJson, parseJsonObject, parseJsonArray } from "./_json";
import crypto from "crypto";
/**
 * 生成任务 CRUD。
 * 提供异步生成任务的创建、状态更新与查询等数据库操作。
 */
import type { GenerationTask } from "@prisma/client";

export type HydratedGenerationTask = Omit<
  GenerationTask,
  "config" | "refImages" | "refAudios" | "refVideos" | "resultUrls"
> & {
  config: Record<string, unknown>;
  refImages: string[];
  refAudios: string[];
  refVideos: string[];
  resultUrls: string[];
};

export async function createTask(data: {
  userId: number;
  type?: string;
  protocol?: string;
  model?: string;
  prompt?: string;
  config?: Record<string, unknown>;
  refImages?: string[];
  refAudios?: string[];
  refVideos?: string[];
  nodeId?: string;
}) {
  const id = crypto.randomUUID();

  const task = await prisma.generationTask.create({
    data: {
      id,
      userId: data.userId,
      type: data.type ?? "image",
      protocol: data.protocol ?? null,
      model: data.model ?? null,
      prompt: data.prompt ?? "",
      config: stringifyJson(data.config ?? {}),
      refImages: data.refImages ? stringifyJson(data.refImages) : null,
      refAudios: data.refAudios ? stringifyJson(data.refAudios) : null,
      refVideos: data.refVideos ? stringifyJson(data.refVideos) : null,
      nodeId: data.nodeId ?? "",
    },
  });
  return deserializeTask(task);
}

export async function getTask(id: string) {
  const task = await prisma.generationTask.findUnique({ where: { id } });
  return task ? deserializeTask(task) : null;
}

/** 读取任务状态（供 service 层判断取消/状态机，避免直调 Prisma） */
export async function getTaskStatus(id: string): Promise<string | null> {
  const task = await prisma.generationTask.findUnique({
    where: { id },
    select: { status: true },
  });
  return task?.status ?? null;
}

/** 判断任务是否已取消（cancelled 终态，或 failed 且 error 标记为 Cancelled） */
export async function isTaskCancelled(id: string): Promise<boolean> {
  const task = await prisma.generationTask.findUnique({
    where: { id },
    select: { status: true, error: true },
  });
  if (!task) return false;
  return task.status === "cancelled" || (task.status === "failed" && task.error === "Cancelled");
}

export async function getTasksByIds(ids: string[]) {
  const tasks = await prisma.generationTask.findMany({
    where: { id: { in: ids } },
  });
  return tasks.map(deserializeTask);
}

export async function getTasksByUser(
  userId: number,
  skip = 0,
  limit = 20
) {
  const tasks = await prisma.generationTask.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    skip,
    take: limit,
  });
  return tasks.map(deserializeTask);
}

export async function updateTaskStatus(
  id: string,
  data: {
    status: string;
    resultUrls?: string[];
    resultText?: string;
    error?: string;
    upstreamTaskId?: string;
    retryCount?: number;
    startedAt?: Date | null;
    completedAt?: Date | null;
    updatedAt?: Date;
  }
) {
  const updateData: Record<string, unknown> = {
    status: data.status,
    updatedAt: data.updatedAt ?? new Date(),
  };

  if (data.resultUrls !== undefined) {
    updateData.resultUrls = stringifyJson(data.resultUrls);
  }
  if (data.resultText !== undefined) {
    updateData.resultText = data.resultText;
  }
  if (data.error !== undefined) {
    updateData.error = data.error;
  }
  if (data.upstreamTaskId !== undefined) {
    updateData.upstreamTaskId = data.upstreamTaskId;
  }
  if (data.retryCount !== undefined) {
    updateData.retryCount = data.retryCount;
  }
  if (data.startedAt !== undefined) {
    updateData.startedAt = data.startedAt;
  }
  if (data.completedAt !== undefined) {
    updateData.completedAt = data.completedAt;
  }

  const task = await prisma.generationTask.update({
    where: { id },
    data: updateData,
  });
  return deserializeTask(task);
}

// 原子领取任务

export async function claimPendingTasks(limit = 10) {
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // 1. 查询 pending 任务
    const candidates = await tx.generationTask.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true },
    });

    const claimed: string[] = [];

    // 2. CAS updateMany 逐个领取
    for (const { id } of candidates) {
      const result = await tx.generationTask.updateMany({
        where: { id, status: "pending" },
        data: { status: "processing", startedAt: now, updatedAt: now },
      });

      if (result.count === 1) {
        claimed.push(id);
      }
    }

    // 3. 返回完整任务
    if (claimed.length === 0) return [];

    const tasks = await tx.generationTask.findMany({
      where: { id: { in: claimed } },
    });
    return tasks.map(deserializeTask);
  });
}

// 僵尸任务清理
// 超过最大重试次数的任务直接判死；未超限则重置为 pending 并递增 retryCount

export async function cleanupZombieTasks(
  stuckMinutes: number,
  maxRetries: number
) {
  const cutoff = new Date(Date.now() - stuckMinutes * 60 * 1000);

  // 1. 超过重试上限 → 判失败
  const dead = await prisma.generationTask.updateMany({
    where: {
      status: "processing",
      updatedAt: { lt: cutoff },
      retryCount: { gte: maxRetries },
    },
    data: {
      status: "failed",
      error: "Task stuck (zombie cleanup, exceeded max retries)",
      updatedAt: new Date(),
    },
  });

  // 2. 未超限 → 重置为 pending，retryCount + 1
  const retried = await prisma.generationTask.updateMany({
    where: {
      status: "processing",
      updatedAt: { lt: cutoff },
      retryCount: { lt: maxRetries },
    },
    data: {
      status: "pending",
      error: null,
      retryCount: { increment: 1 },
      updatedAt: new Date(),
    },
  });

  return dead.count + retried.count;
}

// 启动时恢复未完成的任务

/**
 * 将 processing 状态的任务分类处理：
 * - 有 upstreamTaskId 的异步任务：保持 processing，由 Worker 单独恢复轮询
 * - 无 upstreamTaskId 的同步任务：重置为 pending，重新执行
 */
export async function recoverProcessingTasks(): Promise<{
  recovered: number; // 同步任务重置为 pending
  asyncTasks: HydratedGenerationTask[]; // 异步任务需要继续轮询
}> {
  const allProcessing = await prisma.generationTask.findMany({
    where: { status: "processing" },
  });

  const syncIds: string[] = [];
  const asyncTasks: GenerationTask[] = [];

  for (const t of allProcessing) {
    if (t.upstreamTaskId) {
      asyncTasks.push(t);
    } else {
      syncIds.push(t.id);
    }
  }

  // 同步任务重置为 pending
  if (syncIds.length > 0) {
    await prisma.generationTask.updateMany({
      where: { id: { in: syncIds } },
      data: { status: "pending", error: null, updatedAt: new Date() },
    });
  }

  return { recovered: syncIds.length, asyncTasks: asyncTasks.map(deserializeTask) };
}

// 取消任务
// 取消使用独立的 cancelled 终态，不再复用 failed，便于前端区分

export async function cancelTask(id: string) {
  return prisma.generationTask.updateMany({
    where: { id, status: { in: ["pending", "processing"] } },
    data: {
      status: "cancelled",
      error: "Task cancelled by user",
      completedAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

// 反序列化工具：将 SQLite JSON 字符串解析为对象

function deserializeTask(task: GenerationTask): HydratedGenerationTask {
  return {
    ...task,
    config: parseJsonObject(task.config),
    refImages: parseJsonArray(task.refImages),
    refAudios: parseJsonArray(task.refAudios),
    refVideos: parseJsonArray(task.refVideos),
    resultUrls: parseJsonArray(task.resultUrls),
  };
}
