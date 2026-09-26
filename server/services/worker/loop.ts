/**
 * Worker 主循环。
 * 周期性认领待处理任务、清理僵尸任务并恢复处理中任务，受并发上限约束。
 */

import {
  claimPendingTasks,
  cleanupZombieTasks,
  recoverProcessingTasks,
} from "@server/crud/task";
import type { HydratedGenerationTask } from "@server/crud/task";
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
 * 等待固定时长，同时允许 stopSignal 立即打断。
 * setTimeout 与 stop 检查 interval 必须在任一路径同时清理，否则每次轮询都会泄漏一个 interval。
 */
export function sleepWithStopSignal(
  delayMs: number,
  checkIntervalMs: number,
  stopSignal: StopSignal,
): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearInterval(stopCheck);
      resolve();
    };

    const timeout = setTimeout(finish, delayMs);
    const stopCheck = setInterval(() => {
      if (stopSignal.stopped) finish();
    }, checkIntervalMs);

    // 处理等待开始前就已停机的极端场景；此时两个 timer 都已创建，finish 会一并清理。
    if (stopSignal.stopped) finish();
  });
}

/**
 * Worker 主循环：轮询领取 → p-limit 并发 → 僵尸清理 → 优雅停机
 */
export async function workerLoop(stopSignal: StopSignal): Promise<void> {
  const cfg = getConfig();
  const limit = pLimit(cfg.WORKER_MAX_CONCURRENCY);
  const inFlight = new Set<Promise<void>>();
  let lastZombieCheck = Date.now();

  const scheduleTask = (
    task: HydratedGenerationTask,
    operation: (task: HydratedGenerationTask) => Promise<void>,
  ) => {
    const promise = limit(() => operation(task))
      .catch((err) => {
        logger.error({ err, taskId: task.id }, "Task execution error");
      })
      .finally(() => {
        inFlight.delete(promise);
      });

    inFlight.add(promise);
  };

  // 0. 启动时恢复未完成任务。恢复轮询与新任务共用同一调度器，
  // 避免启动恢复绕过 WORKER_MAX_CONCURRENCY。
  const { recovered, asyncTasks } = await recoverProcessingTasks();
  if (recovered > 0) {
    logEvent("worker.loop", { stage: "recovered", count: recovered });
  }

  if (asyncTasks.length > 0) {
    logEvent("worker.loop", { stage: "resume_async_poll", count: asyncTasks.length });
    for (const task of asyncTasks) {
      scheduleTask(task, (currentTask) => resumeAsyncPolling(currentTask, stopSignal));
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

      // 2. 只认领当前空闲槽位。inFlight 包含运行中和 p-limit 队列中的任务，
      // 否则任务会先被标成 processing 再长时间排队，表现为“卡住”。
      const availableSlots = cfg.WORKER_MAX_CONCURRENCY - inFlight.size;
      if (availableSlots > 0) {
        const tasks = await claimPendingTasks(availableSlots);

        if (tasks.length > 0) {
          logEvent("worker.loop", {
            banner: true,
            bannerTitle: "认领并开始执行任务",
            stage: "claimed",
            count: tasks.length,
          });

          for (const task of tasks) {
            scheduleTask(task, executeTask);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "Worker loop error");
    }

    await sleepWithStopSignal(
      cfg.WORKER_POLL_INTERVAL * 1000,
      cfg.WORKER_POLL_CHECK_INTERVAL,
      stopSignal,
    );
  }

  // 优雅停机：排空运行中与队列中的任务
  logEvent("worker.loop", { stage: "draining", inFlight: inFlight.size });

  if (inFlight.size > 0) {
    const drained = Promise.allSettled([...inFlight]);
    let drainTimeout: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      drainTimeout = setTimeout(resolve, cfg.WORKER_DRAIN_TIMEOUT * 1000);
    });

    await Promise.race([drained, timeout]);
    if (drainTimeout !== undefined) clearTimeout(drainTimeout);
  }

  logEvent("worker.loop", { stage: "stopped" });
}
