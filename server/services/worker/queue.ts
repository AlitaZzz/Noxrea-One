/**
 * BullMQ 队列适配层（specs/task-queue-bullmq.md 规则 2/7）。
 *
 * DB 是任务状态的唯一真源，Redis 只承担派发与进程死亡检测：
 * - job 载荷仅 { taskId }，jobId = taskId（并发双重入队去重）
 * - 重入队唯一原语 = 重激活流程（getJob → 终态则 remove 后 add）
 * - 有界保留：removeOnComplete/removeOnFail 的 remove 是惰性的，终态 job 在
 *   保留窗口内仍占 jobId——隐式 add 幂等不可作为重入队依据
 * - 创建侧 enqueue 失败不回滚不 503（行留 DB，清扫重激活自愈）
 */
import { Queue, DelayedError, type Job } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { getConfig } from "@server/core/config";
import { logEvent, errText } from "@server/core/logger/utils";
import { logger } from "@server/core/logger";

/** 队列名与 key 前缀：专用实例 + 专用前缀，禁止与其他服务共享 */
export const TASK_QUEUE_NAME = "generation-tasks";
export const TASK_QUEUE_PREFIX = "noxrea:queue:";

/** 有界保留（工程常量，随 tick 体量复核；正确性与保留期解耦） */
const REMOVE_ON_COMPLETE = { age: 3600, count: 1000 } as const;
const REMOVE_ON_FAIL = { age: 86400, count: 1000 } as const;
/** 基础设施级瞬断的 BullMQ 重试上限；业务失败由 handler 写 DB 终态正常完成，不经此路径 */
const JOB_ATTEMPTS = 3;

let connection: Redis | null = null;
let queue: Queue | null = null;

function createConnection(): Redis {
  const conn = new IORedis(getConfig().REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  conn.on("error", (err) => {
    // 连接错误只记日志不抛：Redis 短暂抖动由 stalled / 清扫自愈（规则 7），
    // 未处理 error 事件会让进程崩溃，反而扩大故障面
    logger.warn({ err: errText(err) }, "redis connection error");
  });
  return conn;
}

/** 独立连接工厂：Worker 的阻塞命令需专用连接，不与 Queue 共享 */
export function createQueueConnection(): Redis {
  return createConnection();
}

export function getQueueConnection(): Redis {
  if (!connection) connection = createConnection();
  return connection;
}

/**
 * 队列单例（懒构建）。调用前 bootstrap 必须已完成 initTaskQueue 探测；
 * 未探测场景（如单测直接调用）同样懒连接，不在此处隐式重试。
 */
export function getTaskQueue(): Queue {
  if (!queue) {
    queue = new Queue(TASK_QUEUE_NAME, {
      connection: getQueueConnection(),
      prefix: TASK_QUEUE_PREFIX,
      defaultJobOptions: {
        removeOnComplete: REMOVE_ON_COMPLETE,
        removeOnFail: REMOVE_ON_FAIL,
        attempts: JOB_ATTEMPTS,
      },
    });
  }
  return queue;
}

/**
 * 启动探测（bootstrap 调用，规则 7）：PING 失败即启动失败。
 */
export async function initTaskQueue(): Promise<void> {
  const conn = getQueueConnection();
  const pong = await conn.ping();
  if (pong !== "PONG") {
    throw new Error(`Redis PING returned unexpected reply: ${pong}`);
  }
  // 触发队列单例构建，提前暴露连接串/前缀问题
  getTaskQueue();
  logEvent("queue", { stage: "ready", prefix: TASK_QUEUE_PREFIX });
}

/** 停机收尾：断开队列连接（worker 停机流程在 worker.ts） */
export async function closeTaskQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}

// ---------- 重激活原语（规则 2） ----------

export type ReactivationResult = "added" | "skipped";

/**
 * 重入队唯一原语：getJob(taskId) → 无 job ⇒ add；waiting/delayed/active ⇒ 不动作；
 * completed/failed ⇒ remove() 后 add。隐式 add 幂等不可作为重入队依据。
 * 消费入口均为 job 外部视角（规则 2）：创建侧经 reactivateBestEffort、对账清扫。
 * 抛错交调用方按场景处置（创建侧吞掉走清扫自愈；清扫单行失败不阻断本轮）。
 */
export async function reactivateTask(taskId: string): Promise<ReactivationResult> {
  const q = getTaskQueue();
  const job = await q.getJob(taskId);
  if (job) {
    const state = await job.getState();
    if (state === "waiting" || state === "delayed" || state === "active") {
      return "skipped";
    }
    // 终态残留（保留窗口内）：先移除再入队，否则同 jobId add 被忽略
    await job.remove();
  }
  await q.add("dispatch", { taskId }, { jobId: taskId });
  return "added";
}

/**
 * 尽力重激活（规则 7 自愈语义单源）：调度失败仅记日志不抛——调度目标行已落库
 * （pending 或 nextPollAt 已写入），tick 逾期后由对账清扫重激活自愈。
 * 返回 null = 失败已记日志；成功结果透传，成功侧日志由调用方按场景输出。
 */
export async function reactivateBestEffort(
  taskId: string,
  opts: { channel: string; stage: string }
): Promise<ReactivationResult | null> {
  try {
    return await reactivateTask(taskId);
  } catch (err: unknown) {
    logEvent(opts.channel, { level: "warn", stage: opts.stage, taskId, error: errText(err) });
    return null;
  }
}

/**
 * Processor 内自调度唯一原语（规则 2 回写）：jobId = taskId 的 job 在自身 processor
 * 内查 getJob 必为 active，重激活原语对它恒返回 skipped——tick 推进必须走
 * moveToDelayed 原位延迟（BullMQ 文档形态：moveToDelayed 后抛 DelayedError，
 * worker 对该错误跳过 finalize，job 停留 delayed 态由定时器提升后重跑本 processor）。
 *
 * 成功 = 抛出 DelayedError（调用方不得捕获，经 handler 传播回 processor）；
 * 失败（锁丢失/Redis 抖动）= 记 warn 后正常返回——调度目标行（nextPollAt 或
 * pending 重置）已落库，job 走完成终态，tick 逾期后清扫重激活自愈（规则 7）。
 */
export async function deferActiveTickOrThrow(
  ctx: TickDeferContext,
  taskId: string,
  delayUntil: Date
): Promise<void> {
  try {
    await ctx.job.moveToDelayed(delayUntil.getTime(), ctx.token);
  } catch (err: unknown) {
    logEvent("queue", { level: "warn", stage: "tick_defer_failed", taskId, error: errText(err) });
    return;
  }
  logEvent("queue", { stage: "tick_deferred", taskId, delayUntil: delayUntil.toISOString() });
  throw new DelayedError();
}

/** Processor 内自调度上下文：worker 把 processor 收到的 (job, token) 原样下传 */
export interface TickDeferContext {
  job: Job;
  token: string;
}

/**
 * 取消路由的队列侧动作（规则 6）：pending（job waiting）与轮询等待（job delayed）
 * 尽力移除；active 不 remove（语义不可靠），由 handler 读到终态后 no-op 兜底。
 */
export async function cancelQueuedTask(taskId: string): Promise<void> {
  try {
    const q = getTaskQueue();
    const job = await q.getJob(taskId);
    if (!job) return;
    const state = await job.getState();
    if (state === "waiting" || state === "delayed") {
      await job.remove();
      logEvent("queue", { stage: "cancelled_job_removed", taskId, state });
    }
  } catch (err: unknown) {
    // 尽力而为：移除失败仅记日志，handler 终态 no-op 兜底（规则 6）
    logEvent("queue", { level: "warn", stage: "cancelled_job_remove_failed", taskId, error: errText(err) });
  }
}

// ---------- 健康上报（规则 8） ----------

export interface QueueHealth {
  redis: boolean;
  queueDepth: number | null;
}

/**
 * 读数上限：Redis 半开（连接还在、命令不回）时等待会让 `/api/health/ready` 与
 * 指标抓取一起悬挂——这是健康读数，必须自带时限，超时等同不可用
 * （specs/observability-baseline.md 规则 1.2）。
 */
const QUEUE_HEALTH_TIMEOUT_MS = 1_000;

type JobCounts = Record<string, number>;

/**
 * 在途读数：ioredis 在离线队列里保留未完成的命令，而就绪探针与指标抓取会周期性
 * 调用这里。并发调用共用同一条命令，半开连接期间也不会把命令越堆越多；
 * 闸门只在底层命令真正结算后放开（超时不解除——命令还在路上）。
 */
let pendingRead: Promise<JobCounts> | null = null;

function readJobCounts(): Promise<JobCounts> {
  if (pendingRead) return pendingRead;
  // 一条命令取三个状态的计数：轮询读数不该占用三次往返
  const counts = getTaskQueue().getJobCounts("waiting", "delayed", "active");
  pendingRead = counts;
  const release = () => {
    if (pendingRead === counts) pendingRead = null;
  };
  void counts.then(release, release);
  return counts;
}

export async function getQueueHealth(): Promise<QueueHealth> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const counts = readJobCounts();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("queue health timeout")), QUEUE_HEALTH_TIMEOUT_MS);
    });
    const result = await Promise.race([counts, timeout]);
    return {
      redis: true,
      queueDepth: (result.waiting ?? 0) + (result.delayed ?? 0) + (result.active ?? 0),
    };
  } catch {
    return { redis: false, queueDepth: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
