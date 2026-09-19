/**
 * 任务终态事件总线。
 * Worker 写入终态后即时广播，SSE 路由订阅后直推前台（毫秒级）；
 * TaskWatcher 的 DB 轮询仅作为事件丢失时的兜底。
 */
import { EventEmitter } from "node:events";

import type { TerminalTaskState } from "./task-watcher";

const TASK_TERMINAL_EVENT = "task:terminal";

const globalForBus = globalThis as unknown as {
  __noxreaTaskEventBus?: EventEmitter;
};

export const taskEventBus: EventEmitter =
  globalForBus.__noxreaTaskEventBus ?? new EventEmitter();

// 订阅者数量 = 挂起的 SSE 连接数，放宽默认 10 的上限避免偶发警告
taskEventBus.setMaxListeners(200);

if (process.env.NODE_ENV !== "production") {
  globalForBus.__noxreaTaskEventBus = taskEventBus;
}

export function publishTaskTerminal(state: TerminalTaskState): void {
  taskEventBus.emit(TASK_TERMINAL_EVENT, state);
}

/** 订阅所有任务的终态事件（按 taskId 自行过滤），返回取消订阅函数。 */
export function onAnyTaskTerminal(
  listener: (state: TerminalTaskState) => void
): () => void {
  taskEventBus.on(TASK_TERMINAL_EVENT, listener);
  return () => {
    taskEventBus.off(TASK_TERMINAL_EVENT, listener);
  };
}
