import { EventType, type TaskEvent } from "./types";

// ── 进程内 EventBus（对应 backend/app/services/events/bus.py） ──
// 仅用于单进程内的即时事件传递。
// Worker 进程内 publish 的事件对 Next 进程完全不可见。
// 跨进程任务状态同步走 TaskWatcher。

type EventQueue = Array<[TaskEvent | null, () => void]>;

const globalForBus = globalThis as unknown as {
  __noxreaEventBus?: EventBus;
};

export class EventBus {
  private queues = new Map<string, EventQueue>();

  /** 确保 taskId 有一个队列 */
  private ensureQueue(taskId: string): EventQueue {
    let q = this.queues.get(taskId);
    if (!q) {
      q = [];
      this.queues.set(taskId, q);
    }
    return q;
  }

  /** 发布事件到指定 taskId 的所有等待者 */
  publish(taskId: string, event: TaskEvent): void {
    const q = this.queues.get(taskId);
    if (!q) return;

    // 逐个通知所有等待者
    for (const [_, resolve] of q) {
      q[q.indexOf([_, resolve])] = [event, resolve];
      resolve();
    }
  }

  /**
   * 等待事件，返回事件或 null（超时）。
   * 对应 Python EventBus.waitEvent。
   */
  waitEvent(taskId: string, timeoutMs: number): Promise<TaskEvent | null> {
    const q = this.ensureQueue(taskId);

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;

      const entry: [TaskEvent | null, () => void] = [null, () => {}];
      const idx = q.length;
      q.push(entry);

      entry[1] = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(entry[0]);
      };

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 从队列移除
        const pos = q.indexOf(entry);
        if (pos !== -1) q.splice(pos, 1);
        resolve(null);
      }, timeoutMs);
    });
  }

  /** 发送结束信号 */
  sendEnd(taskId: string): void {
    const q = this.queues.get(taskId);
    if (!q) return;

    for (const entry of q) {
      if (!entry[0]) {
        entry[1]();
      }
    }
  }

  /** 取消订阅 */
  unsubscribe(taskId: string): void {
    this.queues.delete(taskId);
  }

  /** 活动订阅数 */
  get size(): number {
    return this.queues.size;
  }
}

export const bus: EventBus =
  globalForBus.__noxreaEventBus ?? new EventBus();

if (process.env.NODE_ENV !== "production") {
  globalForBus.__noxreaEventBus = bus;
}
