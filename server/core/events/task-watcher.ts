import { prisma } from "@server/core/database/client";
import { logger } from "@server/core/logger";

// ── TaskWatcher：跨进程任务状态同步 ──

export interface TerminalTaskState {
  taskId: string;
  status: "completed" | "failed";
  resultUrls?: string[];
  resultText?: string;
  error?: string;
  prompt?: string;
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

      const tasks = await prisma.generationTask.findMany({
        where: {
          id: { in: ids },
          status: { in: ["completed", "failed"] },
        },
        select: {
          id: true,
          status: true,
          resultUrls: true,
          resultText: true,
          error: true,
          config: true,
          prompt: true,
        },
      });

      for (const task of tasks) {
        const subs = this.pending.get(task.id);
        if (!subs) continue;

        const prompt: string | undefined = task.prompt || undefined;

        let resultUrls: string[] | undefined;
        try {
          resultUrls = task.resultUrls
            ? JSON.parse(task.resultUrls)
            : undefined;
        } catch {
          // ignore
        }

        const state: TerminalTaskState = {
          taskId: task.id,
          status: task.status as "completed" | "failed",
          resultUrls,
          resultText: task.resultText ?? undefined,
          error: task.error ?? undefined,
          prompt,
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
