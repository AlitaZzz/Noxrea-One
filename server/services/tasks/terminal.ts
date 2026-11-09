/**
 * 任务终态用例。
 * 写库原语在 `crud/task`（单条守卫语句返回本次写入行），本模块负责：
 * 守卫未命中/写库异常的兜底日志、成功后的事件广播，以及终态事件 payload 映射。
 * 广播只使用本次写入返回的行，不使用重读结果。
 */
import type { TerminalTaskStatus } from "@noxrea/shared";
import { logEvent, errText } from "@server/core/logger/utils";
import { type TaskTerminalFields, writeTaskTerminal } from "@server/crud/task";
import { publishTaskTerminal } from "./event-bus";
import type { TerminalTaskState } from "./terminal-state";

export function toTerminalState(task: TaskTerminalFields): TerminalTaskState {
  return {
    taskId: task.id,
    status: task.status as TerminalTaskStatus,
    resultUrls: task.resultUrls ?? undefined,
    resultText: task.resultText ?? undefined,
    error: task.error ?? undefined,
    errorCode: task.errorCode ?? undefined,
    prompt: task.prompt || undefined,
    config: task.config,
  };
}

/**
 * 终态事件广播：写库成功后的独立收尾。
 * 广播失败（监听器抛错）不能反向改变已提交的终态结果，只记录独立 stage；
 * 事件丢失由 TaskWatcher 的 DB 轮询兜底。
 */
function publishTerminalState(task: TaskTerminalFields): void {
  try {
    publishTaskTerminal(toTerminalState(task));
  } catch (err: unknown) {
    logEvent("task", {
      level: "error",
      stage: "terminal_broadcast_failed",
      taskId: task.id,
      error: errText(err),
    });
  }
}

/**
 * 终态流转的唯一入口：写库成功后广播终态事件，payload 由本次写入返回行构造。
 * 返回 null 表示守卫未命中（任务已属于新执行者或已终态），不得广播。
 */
async function transitionToTerminal(
  id: string,
  status: TerminalTaskStatus,
  data: { resultUrls?: string[]; resultText?: string; error?: string; errorCode?: string },
  startedAt: Date | null
): Promise<TaskTerminalFields | null> {
  const task = await writeTaskTerminal(id, status, data, startedAt);
  if (!task) return null;
  publishTerminalState(task);
  return task;
}

/**
 * completeTask / failTask：模块内私有，仅经 safeCompleteTask / safeFailTask
 * 兜底变体对外使用——终态写入的异常兜底是唯一正确的调用姿势。
 */
function completeTask(
  id: string,
  data: { resultUrls?: string[]; resultText?: string },
  startedAt: Date | null
): Promise<TaskTerminalFields | null> {
  return transitionToTerminal(id, "completed", data, startedAt);
}

function failTask(
  id: string,
  data: { error?: string; errorCode?: string },
  startedAt: Date | null
): Promise<TaskTerminalFields | null> {
  return transitionToTerminal(id, "failed", data, startedAt);
}

/**
 * safe 变体共享的兜底骨架：终态写入动作自身不能抛。
 * 写库失败（DB 抖动）记 terminal_write_failed 返回 null；所有权守卫拒绝记
 * skipped_terminal_write。DB 错误不能流入调用方的 catch——那会把已计费的任务
 * 用 DB 报错误写成对侧终态；守卫拒绝时任务已属于新执行者，同样不能覆盖。
 */
async function safeTerminal(
  id: string,
  write: () => Promise<TaskTerminalFields | null>
): Promise<TaskTerminalFields | null> {
  try {
    const task = await write();
    if (!task) {
      logEvent("task", { stage: "skipped_terminal_write", taskId: id });
    }
    return task;
  } catch (err: unknown) {
    logEvent("task", {
      level: "error",
      stage: "terminal_write_failed",
      taskId: id,
      error: errText(err),
    });
    return null;
  }
}

/**
 * completeTask 的兜底变体：记录成功的动作本身不能抛。
 * completeTask 写库遇 DB 抖动抛错时，异常不能流入 executor 的 catch——那会把
 * 已计费的成功任务用 DB 错误信息写成 failed。任务停留 processing 交给僵尸清理
 * 重试：宁可重跑一次也不误杀成功结果。
 */
export function safeCompleteTask(
  id: string,
  data: { resultUrls?: string[]; resultText?: string },
  startedAt: Date | null
): Promise<TaskTerminalFields | null> {
  return safeTerminal(id, () => completeTask(id, data, startedAt));
}

/**
 * failTask 的兜底变体：记录失败的动作本身不能抛（与 safeCompleteTask 对称）。
 * failTask 抛错（DB 抖动）时不能让 DB 错误被当成生成错误上报给 loop。
 */
export function safeFailTask(
  id: string,
  data: { error?: string; errorCode?: string },
  startedAt: Date | null
): Promise<TaskTerminalFields | null> {
  return safeTerminal(id, () => failTask(id, data, startedAt));
}

// 取消任务
// 取消使用独立的 cancelled 终态，不再复用 failed，便于前端区分
// 令牌传 null 但 cancelled 分支不使用它（pending 行的 startedAt 本就是 null，
// 取消必须能命中未认领的任务）

export function cancelTask(id: string): Promise<TaskTerminalFields | null> {
  return transitionToTerminal(id, "cancelled", {
    error: "Task cancelled by user",
    errorCode: "generation.cancelled",
  }, null);
}
