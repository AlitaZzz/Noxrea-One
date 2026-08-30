/**
 * 任务状态监听器。
 * 监听跨进程任务的状态变更，并同步终态结果至内存与下游。
 */
import { logger } from "@server/core/logger";
import { getTasksByIds } from "@server/crud/task";

export interface TerminalTaskState {
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  resultUrls?: string[];
  resultText?: string;
  error?: string;
  /** 机器可读的失败分类，前端据此取本地化文案 */
  errorCode?: string;
  prompt?: string;
  config?: unknown;
}

interface PendingSubscription {
  taskId: string;
  resolve: (value: TerminalTaskState | null) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

const globalForWatcher = globalThis as unknown as {
  __noxreaTaskWatcher?: TaskWatcher;
};

export class TaskWatcher {
  private pending = new Map<string, PendingSubscription[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollIntervalMs = 1000;
  private startedAt: number | null = null;

  watch(
    taskId: string,
    signal?: AbortSignal
  ): Promise<TerminalTaskState | null> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(null);
        return;
      }

      const sub: PendingSubscription = { taskId, resolve, signal };
      if (signal) {
        sub.abortHandler = () => {
          this.removeSubscription(sub);
          resolve(null);
        };
        signal.addEventListener("abort", sub.abortHandler, { once: true });
      }

      const list = this.pending.get(taskId) ?? [];
      list.push(sub);
      this.pending.set(taskId, list);

      this.ensureTimer();
    });
  }

  get size(): number {
    return this.pending.size;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const subs of this.pending.values()) {
      for (const sub of subs) {
        this.detachAbortHandler(sub);
        sub.resolve(null);
      }
    }
    this.pending.clear();
    this.startedAt = null;
    this.pollIntervalMs = 1000;
  }

  private removeSubscription(sub: PendingSubscription): void {
    const list = this.pending.get(sub.taskId);
    if (!list) return;
    const index = list.indexOf(sub);
    if (index !== -1) list.splice(index, 1);
    if (list.length === 0) this.pending.delete(sub.taskId);
    this.detachAbortHandler(sub);
  }

  private detachAbortHandler(sub: PendingSubscription): void {
    if (sub.signal && sub.abortHandler) {
      sub.signal.removeEventListener("abort", sub.abortHandler);
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    if (this.pending.size === 0) return;

    if (!this.startedAt) this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    this.timer = null;

    if (this.pending.size === 0) return;

    const elapsed = Date.now() - (this.startedAt ?? Date.now());
    this.pollIntervalMs = elapsed < 30_000 ? 1000 : 2000;

    try {
      const ids = [...this.pending.keys()];

      const tasks = await getTasksByIds(ids);
      const terminalTasks = tasks.filter(
        (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled"
      );

      for (const task of terminalTasks) {
        const subs = this.pending.get(task.id);
        if (!subs) continue;

        const state: TerminalTaskState = {
          taskId: task.id,
          status: task.status as "completed" | "failed" | "cancelled",
          resultUrls: task.resultUrls ?? undefined,
          resultText: task.resultText ?? undefined,
          error: task.error ?? undefined,
          errorCode: task.errorCode ?? undefined,
          prompt: task.prompt || undefined,
          config: task.config,
        };

        for (const sub of subs) {
          this.detachAbortHandler(sub);
          sub.resolve(state);
        }
        this.pending.delete(task.id);
      }
    } catch (err) {
      logger.error({ err }, "TaskWatcher poll error");
    }

    if (this.pending.size > 0) {
      this.ensureTimer();
    } else {
      this.startedAt = null;
      this.pollIntervalMs = 1000;
    }
  }
}

export const taskWatcher: TaskWatcher =
  globalForWatcher.__noxreaTaskWatcher ?? new TaskWatcher();

if (process.env.NODE_ENV !== "production") {
  globalForWatcher.__noxreaTaskWatcher = taskWatcher;
}
