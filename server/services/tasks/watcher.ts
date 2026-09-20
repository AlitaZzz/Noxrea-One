/**
 * 任务状态监听器。
 * 终态事件由 Worker 写库后经事件总线即时推送（主路径）；
 * DB 轮询仅作为事件丢失时的兜底，确保状态最终可达。
 */
import { logger } from "@server/core/logger";
import { getTaskTerminalByIds, toTerminalState } from "@server/crud/task";

import { onAnyTaskTerminal } from "./event-bus";

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
  /** 事件总线为主路径，轮询只做兜底，2s 足够 */
  private pollIntervalMs = 2000;
  private busUnsubscribe: (() => void) | null = null;

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

      this.ensureBusListener();
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
    this.busUnsubscribe?.();
    this.busUnsubscribe = null;
    for (const subs of this.pending.values()) {
      for (const sub of subs) {
        this.detachAbortHandler(sub);
        sub.resolve(null);
      }
    }
    this.pending.clear();
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

  /** 终态事件到达：立即唤醒该任务的全部订阅者，无需等轮询 */
  private ensureBusListener(): void {
    if (this.busUnsubscribe) return;
    this.busUnsubscribe = onAnyTaskTerminal((state) => {
      const subs = this.pending.get(state.taskId);
      if (!subs) return;
      for (const sub of subs) {
        this.detachAbortHandler(sub);
        sub.resolve(state);
      }
      this.pending.delete(state.taskId);
    });
  }

  private ensureTimer(): void {
    if (this.timer) return;
    if (this.pending.size === 0) return;

    this.timer = setTimeout(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    this.timer = null;

    if (this.pending.size === 0) return;

    try {
      const ids = [...this.pending.keys()];

      // 投影查询：轮询兜底只消费 toTerminalState 的 8 个字段，不拉大 JSON 列；
      // 查询本身只返回终态行，无需再内存过滤
      const terminalTasks = await getTaskTerminalByIds(ids);

      for (const task of terminalTasks) {
        const subs = this.pending.get(task.id);
        if (!subs) continue;

        // 与事件总线主路径共用同一映射，保证兜底路径的 payload 形状一致
        const state = toTerminalState(task);

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
    }
  }
}

export const taskWatcher: TaskWatcher =
  globalForWatcher.__noxreaTaskWatcher ?? new TaskWatcher();

if (process.env.NODE_ENV !== "production") {
  globalForWatcher.__noxreaTaskWatcher = taskWatcher;
}
