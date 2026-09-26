import { prisma } from "@server/core/database/client";
import { TASK_TERMINAL_STATUSES } from "@noxrea/shared";
import { stringifyJson, parseJsonObject, parseJsonArray } from "./json-column";
import { publishTaskTerminal } from "@server/services/tasks/event-bus";
import { logEvent, errText } from "@server/core/logger/utils";
import type { TerminalTaskState } from "@server/services/tasks/watcher";
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

/** 判断任务是否已取消（cancelled 终态） */
export async function isTaskCancelled(id: string): Promise<boolean> {
  try {
    const task = await prisma.generationTask.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!task) return false;
    return task.status === "cancelled";
  } catch (err: unknown) {
    // DB 抖动时视为未取消：取消检查抛错会让轮询循环整体死亡、心跳停止，
    // 僵尸清理随后重置并重复提交上游（重复计费）。DB 恢复后下一次检查
    // 自然能读到取消标记
    logEvent("task", {
      level: "warn",
      stage: "cancelled_check_failed",
      taskId: id,
      error: errText(err),
    });
    return false;
  }
}

/**
 * 保存 upstream_task_id（任务认领后的 processing 阶段）。
 * 带双重守卫：status=processing 且 startedAt 与认领时一致——任务已被取消/终态、
 * 被僵尸清理重置、或已被重新认领（startedAt 变化）时写入被丢弃。无守卫的写会把
 * 已取消任务复活回 processing；只查 status 的守卫则会让失去所有权的旧执行者
 * 覆盖新执行者刚写入的 upstreamTaskId（重复轮询、孤儿上游任务）。
 * 返回 false 表示写入被丢弃。
 */
export async function markTaskProcessing(
  id: string,
  upstreamTaskId: string,
  expectedStartedAt: Date | null
): Promise<boolean> {
  const now = new Date();
  const res = await prisma.generationTask.updateMany({
    where: { id, status: "processing", startedAt: expectedStartedAt },
    data: { upstreamTaskId, updatedAt: now },
  });
  return res.count === 1;
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
  const now = new Date();
  const cutoff = new Date(now.getTime() - stuckMinutes * 60 * 1000);

  // 1. 超过重试上限 → 判失败。谓词在写入时点复查（updateMany 的 where 与
  //    SELECT 完全一致）：SELECT 与写入之间若有排队的心跳落库（任务其实存活），
  //    该行不再满足 updatedAt < cutoff，写入被跳过——逐个 failTask 的旧实现
  //    守卫只剩 status，会把这种任务误杀并导致上游重复计费；同时批量写入把
  //    2N+1 条串行查询收敛为固定 2 条，不再阻塞 worker 循环内的领取。
  const deadWhere = {
    status: "processing",
    updatedAt: { lt: cutoff },
    retryCount: { gte: maxRetries },
  };
  const deadCandidates = await prisma.generationTask.findMany({
    where: deadWhere,
    select: { id: true },
  });
  let deadCount = 0;
  if (deadCandidates.length > 0) {
    const deadIds = deadCandidates.map((t) => t.id);
    const dead = await prisma.generationTask.updateMany({
      where: { id: { in: deadIds }, ...deadWhere },
      data: {
        status: "failed",
        error: "Task stuck (zombie cleanup, exceeded max retries)",
        errorCode: "generation.zombie_timeout",
        completedAt: now,
        updatedAt: now,
      },
    });
    deadCount = dead.count;
    // 广播终态：只读回真正被本次写入判死的行（其余执行者的终态写入自带广播）
    if (dead.count > 0) {
      const rows = await prisma.generationTask.findMany({
        where: { id: { in: deadIds }, status: "failed" },
        select: TERMINAL_FIELDS_SELECT,
      });
      for (const row of rows) {
        publishTaskTerminal(toTerminalState(deserializeTerminalRow(row)));
      }
    }
  }

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

  return deadCount + retried.count;
}

/** 心跳间隔（ms）：轮询期间推进 updatedAt 的频率，须远小于 WORKER_STUCK_TIMEOUT */
export const TASK_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * 轮询心跳：只推进 updatedAt，不触碰任何业务字段。
 *
 * 僵尸清理以 updatedAt 判定任务是否卡死，而异步轮询可能持续十几分钟（视频生成很
 * 常见）。轮询期间不心跳的话，updatedAt 会一直停在「保存 upstreamTaskId」那一刻，
 * 长任务必然被误判为僵尸并重置重跑——上游于是重复生成、重复计费，旧任务还沦为
 * 无人接收的孤儿。
 *
 * 双重守卫：只在任务仍为 processing 且 startedAt 与认领时一致时更新——
 * 失去所有权的旧执行者（任务被僵尸重置后重新认领）不能推进新所有者认领行的
 * updatedAt，否则新执行者真挂死时僵尸清理会因时间戳新鲜而迟迟发现不了。
 */
export async function touchTaskHeartbeat(
  id: string,
  expectedStartedAt: Date | null
): Promise<boolean> {
  try {
    const result = await prisma.generationTask.updateMany({
      where: { id, status: "processing", startedAt: expectedStartedAt },
      data: { updatedAt: new Date() },
    });
    return result.count === 1;
  } catch (err: unknown) {
    // DB 错误不能被解释为所有权丢失；继续轮询，等下一次心跳恢复后重试。
    logEvent("task", {
      level: "warn",
      stage: "heartbeat_write_failed",
      taskId: id,
      error: errText(err),
    });
    return true;
  }
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

// 终态写入（completed / failed / cancelled）

/** 终态事件映射所需的字段集：完整任务行与对账投影查询的行均满足此结构 */
export type TaskTerminalFields = Pick<
  HydratedGenerationTask,
  "id" | "status" | "resultUrls" | "resultText" | "error" | "errorCode" | "prompt" | "config"
>;

/** 终态判断的单一谓词：取消路由、SSE 路由与 watcher 兜底共用，避免字面量逐处漂移 */
export function isTerminalTaskStatus(status: string): status is TerminalTaskState["status"] {
  return (TASK_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** 终态回填/广播所需的投影列：避免拉取 refImages/refAudios/refVideos 等大 JSON 列后丢弃 */
const TERMINAL_FIELDS_SELECT = {
  id: true,
  status: true,
  resultUrls: true,
  resultText: true,
  error: true,
  errorCode: true,
  prompt: true,
  config: true,
  userId: true,
} as const;

function deserializeTerminalRow(
  t: { [K in keyof typeof TERMINAL_FIELDS_SELECT]: unknown }
): TaskTerminalFields & { userId: number } {
  return {
    id: t.id as string,
    status: t.status as string,
    resultUrls: parseJsonArray(t.resultUrls as string | null),
    resultText: t.resultText as string | null,
    error: t.error as string | null,
    errorCode: t.errorCode as string | null,
    prompt: t.prompt as string,
    config: parseJsonObject(t.config as string),
    userId: t.userId as number,
  };
}

export function toTerminalState(task: TaskTerminalFields): TerminalTaskState {
  return {
    taskId: task.id,
    status: task.status as TerminalTaskState["status"],
    resultUrls: task.resultUrls ?? undefined,
    resultText: task.resultText ?? undefined,
    error: task.error ?? undefined,
    errorCode: task.errorCode ?? undefined,
    prompt: task.prompt || undefined,
    config: task.config,
  };
}

/**
 * 对账接口专用投影：只查终态回填需要的字段，
 * 避免把 refImages/refAudios/refVideos 等大 JSON 列整批拉出后丢弃。
 * 只返回终态行（watcher 兜底与对账接口都只消费终态，过滤下推 SQL，
 * 免得先拉取并反序列化 config/resultUrls 再在内存中丢弃）；
 * opts.userId 可进一步在 SQL 层限定归属。
 */
export async function getTaskTerminalByIds(
  ids: string[],
  opts?: { userId?: number }
): Promise<(TaskTerminalFields & { userId: number })[]> {
  const tasks = await prisma.generationTask.findMany({
    where: {
      id: { in: ids },
      status: { in: ["completed", "failed", "cancelled"] },
      ...(opts?.userId !== undefined ? { userId: opts.userId } : {}),
    },
    select: TERMINAL_FIELDS_SELECT,
  });
  return tasks.map(deserializeTerminalRow);
}

/**
 * 终态流转的唯一入口：写入成功后广播终态事件，重读用投影查询构建 payload。
 * 守卫规则：
 * - completed/failed 只发生在已被认领的执行（processing）上，且无条件携带
 *   认领时间戳令牌（startedAt）：状态为 pending 说明僵尸清理已重置重试、
 *   时间戳不匹配说明任务已被重新认领——两种情况本执行者都已失去所有权，
 *   写入会误杀新一轮执行。令牌必填且无条件进 where：startedAt 为 null 时
 *   （不应发生于已认领任务）IS NULL 过滤匹配不到任何已认领行，写入被
 *   丢弃——宁可拒绝也不可无守卫覆盖。
 * - cancelled 来自用户操作，pending 的排队任务同样可以取消；cancelled 分支
 *   不带令牌过滤（pending 行的 startedAt 为 null，无法用令牌命中）。
 * 返回 null 表示任务不满足守卫条件，本次写入被丢弃。
 */
async function transitionToTerminal(
  id: string,
  status: TerminalTaskState["status"],
  data: Record<string, unknown>,
  ownership: { startedAt: Date | null }
): Promise<TaskTerminalFields | null> {
  const now = new Date();
  const where = status === "cancelled"
    ? { id, status: { in: ["pending", "processing"] } }
    : { id, status: "processing", startedAt: ownership.startedAt };
  const res = await prisma.generationTask.updateMany({
    where,
    data: { status, completedAt: now, updatedAt: now, ...data },
  });
  if (res.count === 0) return null;
  const row = await prisma.generationTask.findUnique({
    where: { id },
    select: TERMINAL_FIELDS_SELECT,
  });
  if (!row) return null;
  const task = deserializeTerminalRow(row);
  publishTaskTerminal(toTerminalState(task));
  return task;
}

/**
 * completeTask / failTask：模块内私有，仅经 safeCompleteTask / safeFailTask
 * 兜底变体对外使用——终态写入的异常兜底是唯一正确的调用姿势。
 */
function completeTask(
  id: string,
  data: { resultUrls?: string[]; resultText?: string },
  ownership: { startedAt: Date | null }
): Promise<TaskTerminalFields | null> {
  return transitionToTerminal(id, "completed", {
    ...(data.resultUrls !== undefined ? { resultUrls: stringifyJson(data.resultUrls) } : {}),
    ...(data.resultText !== undefined ? { resultText: data.resultText } : {}),
  }, ownership);
}

function failTask(
  id: string,
  data: { error?: string; errorCode?: string },
  ownership: { startedAt: Date | null }
): Promise<TaskTerminalFields | null> {
  return transitionToTerminal(id, "failed", {
    ...(data.error !== undefined ? { error: data.error } : {}),
    ...(data.errorCode !== undefined ? { errorCode: data.errorCode } : {}),
  }, ownership);
}

/**
 * safe 变体共享的兜底骨架：终态写入动作自身不能抛。
 * 写库失败（DB 抖动）记 terminal_write_failed 返回 null；所有权守卫拒绝记
 * skipped_terminal_write。DB 错误不能流入调用方的 catch——那会把已计费的任务
 * 用 DB 报错误写成对侧终态；守卫拒绝时任务已属于新执行者，同样不能覆盖。
 */
async function safeTerminal(
  id: string,
  write: () => Promise<TaskTerminalFields | null>
): Promise<TaskTerminalFields | null> {
  try {
    const task = await write();
    if (!task) {
      logEvent("task", { stage: "skipped_terminal_write", taskId: id });
    }
    return task;
  } catch (err: unknown) {
    logEvent("task", {
      level: "error",
      stage: "terminal_write_failed",
      taskId: id,
      error: errText(err),
    });
    return null;
  }
}

/**
 * completeTask 的兜底变体：记录成功的动作本身不能抛。
 * completeTask 写库遇 DB 抖动抛错时，异常不能流入 executor 的 catch——那会把
 * 已计费的成功任务用 DB 错误信息写成 failed。任务停留 processing 交给僵尸清理
 * 重试：宁可重跑一次也不误杀成功结果。
 */
export function safeCompleteTask(
  id: string,
  data: { resultUrls?: string[]; resultText?: string },
  ownership: { startedAt: Date | null }
): Promise<TaskTerminalFields | null> {
  return safeTerminal(id, () => completeTask(id, data, ownership));
}

/**
 * failTask 的兜底变体：记录失败的动作本身不能抛（与 safeCompleteTask 对称）。
 * failTask 抛错（DB 抖动）时不能让 DB 错误被当成生成错误上报给 loop。
 */
export function safeFailTask(
  id: string,
  data: { error?: string; errorCode?: string },
  ownership: { startedAt: Date | null }
): Promise<TaskTerminalFields | null> {
  return safeTerminal(id, () => failTask(id, data, ownership));
}

// 取消任务
// 取消使用独立的 cancelled 终态，不再复用 failed，便于前端区分
// 令牌传 null 但 cancelled 分支不使用它（pending 行的 startedAt 本就是 null，
// 取消必须能命中未认领的任务）

export function cancelTask(id: string): Promise<TaskTerminalFields | null> {
  return transitionToTerminal(id, "cancelled", {
    error: "Task cancelled by user",
    errorCode: "generation.cancelled",
  }, { startedAt: null });
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
