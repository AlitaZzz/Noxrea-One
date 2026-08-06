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
  prompt?: string;
  config?: unknown;
}

interface PendingSubscription {
  taskId: string;
  resolve: (value: TerminalTaskState | null) => void;
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
      const sub: PendingSubscription = { taskId, resolve };

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            const list = this.pending.get(taskId);
            if (list) {
              const idx = list.indexOf(sub);
              if (idx !== -1) list.splice(idx, 1);
              if (list.length === 0) this.pending.delete(taskId);
            }
            resolve(null);
          },
          { once: true }
        );
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

  private ensureTimer(): void {
    if (this.timer) return;
    if (this.pending.size === 0) return;

    if (!this.startedAt) this.startedAt = Date.now();
    this.timer = setTimeout(() => this.poll(), this.pollIntervalMs);
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
          prompt: task.prompt || undefined,
        };

        for (const sub of subs) {
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
