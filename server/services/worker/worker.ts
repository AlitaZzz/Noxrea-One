/**
 * BullMQ Worker 运行器（specs/task-queue-bullmq.md 规则 1/9）。
 *
 * - 并发槽：max_concurrency 全局生效，执行段与轮询 tick 同受约束（规则 1）
 * - stalled 检测：lockDuration 30s / stalledInterval 30s / maxStalledCount 2（规则 5 工程常量）
 * - per-job abort：停机排空超时后中止在途上游请求/下载（先礼后兵，同现状语义）
 * - 停机时序（规则 9）：停止接新 job → drain 窗口排空 → 超时 abort → 有界等待；
 *   BullMQ 的 close 幂等（closing 期间重复调用返回同一 Promise，force 参数首调后
 *   不可达），故不存在可靠的二次强制关闭——仍不落定者交进程退出兜底，残留 job
 *   由 stalled 机制在新进程恢复
 */

import { Worker } from "bullmq";
import { logEvent, errText } from "@server/core/logger/utils";
import { logger } from "@server/core/logger";
import { secondsToMs } from "@server/core/duration";
import { getSetting } from "@server/core/settings";
import { processTaskJob } from "./handler";
import {
  TASK_QUEUE_NAME,
  TASK_QUEUE_PREFIX,
  createQueueConnection,
} from "./queue";

/** BullMQ 工程常量（规则 5）：锁 30s（自动续约 15s）、stalled 检测 30s、封顶 2 次 */
const LOCK_DURATION_MS = 30_000;
const STALLED_INTERVAL_MS = 30_000;
const MAX_STALLED_COUNT = 2;

let worker: Worker | null = null;
/** 停机中标志：排空超时后对活跃 job 触发 per-job abort */
let stopping = false;
/** job 消费者标记（jobId = taskId）→ 中止控制器；job 落定后清理。
 *  同 taskId 的并发活跃 job 在单进程内被 BullMQ 的 job 锁排除；跨进程 stalled
 *  交接时各进程各自持有并中止自己的在途请求，本 Map 无键冲突面。 */
const controllers = new Map<string, AbortController>();

/** worker 自持专用连接（阻塞命令不与 Queue 共享连接），停机时随 worker 断开 */
let workerConnection: ReturnType<typeof createQueueConnection> | null = null;

export function isTaskWorkerRunning(): boolean {
  return worker !== null && !stopping;
}

export function startTaskWorker(): void {
  // 停机中不可重启（状态机单义）；本进程仅启动期调用一次，防御并发重入
  if (worker || stopping) return;

  const concurrency = getSetting("worker.max_concurrency");
  stopping = false;
  workerConnection = createQueueConnection();

  worker = new Worker<{ taskId: string }>(
    TASK_QUEUE_NAME,
    async (job, token) => {
      const taskId = job.data?.taskId;
      if (typeof taskId !== "string" || taskId === "") {
        // 载荷损坏：无从分派，记日志后让 job 正常完成（终态由 DB 行数据自证）
        logEvent("worker", { level: "warn", stage: "malformed_job_payload", jobId: job.id });
        return;
      }
      const controller = new AbortController();
      controllers.set(taskId, controller);
      try {
        // (job, token) 原样下传：tick 自调度（moveToDelayed）需要 job 锁令牌
        await processTaskJob(taskId, controller.signal, { job, token: token ?? "" });
      } finally {
        controllers.delete(taskId);
      }
    },
    {
      connection: workerConnection,
      prefix: TASK_QUEUE_PREFIX,
      concurrency,
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: MAX_STALLED_COUNT,
    }
  );

  worker.on("failed", (job, err) => {
    // 业务失败在 handler 内写 DB 终态后正常完成，不经此路径；此处仅基础设施级
    // 重试（attempts=3）耗尽后的残留——DB 行留待清扫重激活自愈（规则 7）
    logger.error({ err: errText(err), jobId: job?.id }, "task job failed after retries");
  });
  worker.on("error", (err) => {
    logger.error({ err: errText(err) }, "task worker error");
  });
  worker.on("stalled", (jobId) => {
    logEvent("worker", { level: "warn", stage: "job_stalled", jobId });
  });

  logEvent("worker", { stage: "started", concurrency });
}

export async function stopTaskWorker(): Promise<void> {
  const w = worker;
  if (!w) return;
  worker = null;
  stopping = true;

  const drainMs = secondsToMs(getSetting("worker.drain_timeout_seconds"));
  let closed = false;
  const closing = w
    .close()
    .then(() => {
      closed = true;
    })
    .catch((err: unknown) => {
      // close() 异常不阻断停机流程：残留 job 交给 stalled 机制在新进程恢复
      logger.error({ err: errText(err) }, "task worker close error");
    });

  // 1. 停止接新 job（close 已隐含）→ drain 窗口内等待活跃 job 排空
  await Promise.race([closing, sleep(drainMs)]);

  // 2. 超时未排空：对在途 job 触发 per-job abort（在途上游请求/下载中止）
  if (!closed) {
    logEvent("worker", {
      level: "warn",
      stage: "drain_timeout_abort",
      active: controllers.size,
    });
    for (const controller of controllers.values()) controller.abort();
    // 3. 有界等待落定（abort 后请求应快速中止，窗口取 drain 窗口本身）
    await Promise.race([closing, sleep(drainMs)]);
  }

  // 4. 收尾：断开自持连接；close 若仍未落定则放弃等待（进程即将退出，残留 job
  //    由 stalled 恢复）。迟到的 close 结局（resolve/reject）已在回调中消化，
  //    无悬空 rejection；进程退出由 index.ts 的 exitBound 兜底
  if (!closed) {
    logEvent("worker", {
      level: "warn",
      stage: "close_abandoned",
      note: "residual jobs recover via stalled in next process",
    });
  }
  stopping = false;
  if (workerConnection) {
    workerConnection.disconnect();
    workerConnection = null;
  }
  logEvent("worker", { stage: "stopped" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
