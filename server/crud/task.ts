import { prisma } from "@server/core/database/client";
import { stringifyJson } from "./_json";
import crypto from "crypto";

// ── Task CRUD（对应 backend/app/crud/task.py） ──

export async function createTask(data: {
  userId: number;
  type?: string;
  capability?: string;
  protocol?: string;
  model?: string;
  prompt?: string;
  config?: Record<string, unknown>;
  refImages?: string[];
  nodeId?: string;
}) {
  const id = crypto.randomUUID();

  return prisma.generationTask.create({
    data: {
      id,
      userId: data.userId,
      type: data.type ?? "image",
      capability: data.capability ?? null,
      protocol: data.protocol ?? null,
      model: data.model ?? null,
      prompt: data.prompt ?? "",
      config: stringifyJson(data.config ?? {}),
      refImages: data.refImages ? stringifyJson(data.refImages) : null,
      nodeId: data.nodeId ?? "",
    },
  });
}

export async function getTask(id: string) {
  return prisma.generationTask.findUnique({ where: { id } });
}

export async function getTasksByUser(
  userId: number,
  skip = 0,
  limit = 20
) {
  return prisma.generationTask.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    skip,
    take: limit,
  });
}

export async function updateTaskStatus(
  id: string,
  data: {
    status: string;
    resultUrls?: string[];
    resultText?: string;
    error?: string;
    upstreamTaskId?: string;
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

  return prisma.generationTask.update({
    where: { id },
    data: updateData,
  });
}

// ── 原子领取任务（对应 claim_pending_tasks） ──

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
        data: { status: "processing", updatedAt: now },
      });

      if (result.count === 1) {
        claimed.push(id);
      }
    }

    // 3. 返回完整任务
    if (claimed.length === 0) return [];

    return tx.generationTask.findMany({
      where: { id: { in: claimed } },
    });
  });
}

// ── 僵尸任务清理 ──

export async function cleanupZombieTasks(stuckMinutes: number) {
  const cutoff = new Date(Date.now() - stuckMinutes * 60 * 1000);

  const result = await prisma.generationTask.updateMany({
    where: {
      status: "processing",
      updatedAt: { lt: cutoff },
    },
    data: {
      status: "failed",
      error: "Task stuck (zombie cleanup)",
      updatedAt: new Date(),
    },
  });

  return result.count;
}

// ── 启动时恢复未完成的任务 ──

/**
 * 将 processing 状态的任务分类处理：
 * - 有 upstreamTaskId 的异步任务：保持 processing，由 Worker 单独恢复轮询
 * - 无 upstreamTaskId 的同步任务：重置为 pending，重新执行
 */
export async function recoverProcessingTasks(): Promise<{
  recovered: number;          // 同步任务重置为 pending
  asyncTasks: GenerationTask[]; // 异步任务需要继续轮询
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

  return { recovered: syncIds.length, asyncTasks };
}

// ── 取消任务 ──

export async function cancelTask(id: string) {
  return prisma.generationTask.updateMany({
    where: { id, status: { in: ["pending", "processing"] } },
    data: {
      status: "failed",
      error: "Task cancelled by user",
      updatedAt: new Date(),
    },
  });
}
