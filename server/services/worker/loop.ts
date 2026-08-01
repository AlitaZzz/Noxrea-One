// ── Worker 主循环（对应 backend/app/services/worker/loop.py） ──

import { claimPendingTasks, cleanupZombieTasks, recoverProcessingTasks } from "@server/crud/task";
import { executeTask } from "./executor";
import { resumeAsyncPolling } from "./resume-polling";
import { getConfig } from "@server/core/config";
import { logEvent } from "@server/core/logger/utils";
import { logger } from "@server/core/logger";
import pLimit from "p-limit";

export interface StopSignal {
  readonly stopped: boolean;
}

/**
 * Worker 主循环：轮询领取 → p-limit 并发 → 僵尸清理 → 优雅停机
 */
export async function workerLoop(stopSignal: StopSignal): Promise<void> {
  const cfg = getConfig();
  const limit = pLimit(cfg.WORKER_MAX_CONCURRENCY);
  const inFlight = new Set<Promise<void>>();
  let lastZombieCheck = Date.now();

  // 0. 启动时恢复未完成任务
  const { recovered, asyncTasks } = await recoverProcessingTasks();
  if (recovered > 0) {
    logEvent("worker.loop", { stage: "recovered", count: recovered });
  }
  // 异步任务：直接恢复轮询，不重新提交
  if (asyncTasks.length > 0) {
    logEvent("worker.loop", { stage: "resume_async_poll", count: asyncTasks.length });
    for (const task of asyncTasks) {
      resumeAsyncPolling(task, stopSignal);
    }
  }

  logEvent("worker.loop", {
    stage: "started",
    pollInterval: cfg.WORKER_POLL_INTERVAL,
    maxConcurrency: cfg.WORKER_MAX_CONCURRENCY,
  });

  while (!stopSignal.stopped) {
    try {
      // 1. 僵尸任务清理
      const now = Date.now();
      if (now - lastZombieCheck > cfg.WORKER_ZOMBIE_INTERVAL * 1000) {
        const count = await cleanupZombieTasks(cfg.WORKER_STUCK_TIMEOUT, cfg.WORKER_MAX_RETRIES);
        if (count > 0) {
          logEvent("worker.loop", { stage: "zombie_cleanup", count });
        }
        lastZombieCheck = now;
      }

      // 2. 原子领取任务
      const tasks = await claimPendingTasks(cfg.WORKER_MAX_CONCURRENCY);

      if (tasks.length > 0) {
        logEvent("worker.loop", { stage: "claimed", count: tasks.length });
      }

      // 3. 并发执行
      for (const task of tasks) {
        const p = limit(() => executeTask(task))
          .catch((err) => {
            logger.error({ err, taskId: task.id }, "Task execution error");
          })
          .finally(() => {
            inFlight.delete(p);
          });

        inFlight.add(p);
      }
    } catch (err) {
      logger.error({ err }, "Worker loop error");
    }

    // 等待轮询间隔
    await new Promise((r) => {
      const timer = setTimeout(r, cfg.WORKER_POLL_INTERVAL * 1000);
      const check = setInterval(() => {
        if (stopSignal.stopped) {
          clearTimeout(timer);
          clearInterval(check);
          r(undefined);
        }
      }, 200);
    });
  }

  // ── 优雅停机：排空在途任务 ──
  logEvent("worker.loop", { stage: "draining", inFlight: inFlight.size });

  if (inFlight.size > 0) {
    const drainTimeout = 15_000;
    const drained = Promise.allSettled([...inFlight]);
    const timeout = new Promise<void>((r) => setTimeout(r, drainTimeout));

    await Promise.race([drained, timeout]);
  }

  logEvent("worker.loop", { stage: "stopped" });
}
