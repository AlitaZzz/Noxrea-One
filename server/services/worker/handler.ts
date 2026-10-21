/**
 * 任务 job 处理器（specs/task-queue-bullmq.md 规则 1：DB 状态分派）。
 * 每次 job 执行都从 DB 重新加载任务，按行状态分派：
 *   pending → CAS 认领 → 提交段 / 轮询尝试
 *   processing + upstreamTaskId → 单次轮询尝试（tick）
 *   processing + 无 upstreamTaskId → 租约新鲜跳过 / in_flight 过期判失败 / not_sent 过期接管
 *   终态 → noop
 * Handler 不持有任何跨 job 状态；重复投递天然幂等（认领/闸门/defer 均为 CAS 守卫）。
 */

import { logEvent } from "@server/core/logger/utils";
import { getSetting } from "@server/core/settings";
import {
  getTask,
  claimPendingTask,
  takeOverInterruptedTask,
  safeFailTask,
  isTerminalTaskStatus,
  stuckLeaseCutoff,
} from "@server/crud/task";
import { executeSubmissionPhase } from "./executor";
import { runPollAttempt } from "./poll-attempt";
import type { TickDeferContext } from "./queue";

export async function processTaskJob(
  taskId: string,
  signal: AbortSignal,
  deferCtx: TickDeferContext
): Promise<void> {
  const task = await getTask(taskId);
  if (!task) {
    logEvent("worker", { stage: "task_row_missing", taskId });
    return;
  }

  // 终态（completed / failed / cancelled）：job 是迟到或重复投递，无事可做
  if (isTerminalTaskStatus(task.status)) return;

  // pending：认领（CAS，输给其他实例时返回 null），按 upstreamTaskId 分派。
  // 有 upstreamTaskId 的 pending 行来自「预算耗尽重入队」的轮询恢复会话——立即执行首轮
  if (task.status === "pending") {
    const claimed = await claimPendingTask(taskId);
    if (!claimed) {
      logEvent("worker", { stage: "claim_lost", taskId });
      return;
    }
    if (claimed.upstreamTaskId) {
      await runPollAttempt(claimed, signal, deferCtx);
    } else {
      await executeSubmissionPhase(claimed, signal, deferCtx);
    }
    return;
  }

  // processing + 已受理：轮询段（tick），无需认领——poll/defer 的 startedAt 令牌守卫兜底
  if (task.upstreamTaskId) {
    await runPollAttempt(task, signal, deferCtx);
    return;
  }

  // processing + 未受理：stalled 重跑 / 清扫重激活 / 他实例在途 交织的裁决段。
  // 租约新鲜（updatedAt 在 stuck 窗口内）= 某实例的执行者存活在途，跳过
  const leaseCutoff = stuckLeaseCutoff();
  if (task.updatedAt >= leaseCutoff) {
    logEvent("worker", { stage: "lease_fresh_skip", taskId });
    return;
  }

  // in_flight 且租约过期：提交已过闸门、结果未知（可能已在上游受理），
  // 绝不重发——按提交不确定判失败（规则 3 残余风险处置）。无需「写时」租约复查：
  // 闸门写入后提交 ≤ api_timeout 240s、下载 ≤ 总时长 600s 且带 30s 心跳，
  // 存活执行者的最后写入必然落在 stuck 窗口（15min）内；能呈现过期 in_flight 的
  // 只可能是死亡执行者。且 failTask 是无重提交风险的终态判定，与接管 CAS
  // （改写所有权、须谓词内复查）风险等级不同
  if (task.submissionState === "in_flight") {
    logEvent("worker", { stage: "submission_uncertain_judged", taskId });
    await safeFailTask(taskId, {
      error: "任务执行中断（提交结果不确定），为避免重复提交上游已放弃重试",
      errorCode: "generation.submission_uncertain",
    }, { startedAt: task.startedAt });
    return;
  }

  // not_sent 且租约过期：提交从未发出（闸门前中断），可安全重提。
  // 接管 CAS：预算内（retryCount < max_retries）重置租约 + 计数，预算耗尽判失败
  const takeover = await takeOverInterruptedTask(taskId, leaseCutoff, getSetting("worker.max_retries"));
  if (takeover.kind === "taken") {
    logEvent("worker", {
      stage: "interrupted_task_taken_over",
      taskId,
      retryCount: takeover.task.retryCount,
    });
    await executeSubmissionPhase(takeover.task, signal, deferCtx);
    return;
  }
  if (takeover.kind === "budget_exhausted") {
    logEvent("worker", { stage: "interrupt_budget_exhausted", taskId });
    await safeFailTask(taskId, {
      error: "任务多次执行中断，重试预算已耗尽，为避免重复提交上游已放弃重试",
      errorCode: "generation.interrupted_retry_exhausted",
    }, { startedAt: task.startedAt });
    return;
  }
  // lost：接管输给并发竞争（他实例已接管/已收口），本轮放弃
  logEvent("worker", { stage: "takeover_lost", taskId });
}
