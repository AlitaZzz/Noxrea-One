/**
 * 对账清扫（specs/task-queue-bullmq.md 规则 7：最终一致的安全网）。
 * 周期扫描 DB 中的失联行并重激活：
 *   - pending 且心跳逾期（无人认领：enqueue 失败 / 派发丢失）
 *   - processing 执行段且租约过期（执行者死亡，无 upstreamTaskId）
 *   - processing 轮询段且 tick 逾期（nextPollAt 已到但无 live job：调度丢失）
 * 重激活经 queue.reactivateTask：job 仍存活（waiting/delayed/active）则跳过——
 * 清扫只负责「DB 有活、队列无 job」的缝隙，与 stalled 机制互补不重叠。
 */

import { logEvent, errText } from "@server/core/logger/utils";
import { getSetting } from "@server/core/settings";
import { findReconcileCandidates, stuckLeaseCutoff } from "@server/crud/task";
import { reactivateTask } from "./queue";

let timer: ReturnType<typeof setInterval> | null = null;
/** 防重入：上轮未扫完则本轮跳过（候选集幂等，漏一轮无害） */
let sweeping = false;

export function startReconcileSweep(): void {
  if (timer) return;
  const intervalMs = getSetting("worker.zombie_scan_interval_seconds") * 1000;
  timer = setInterval(() => {
    void reconcileSweep().catch((err: unknown) => {
      // 周期任务自身不抛：DB/Redis 抖动仅记日志，下一周期重试
      logEvent("reconcile", { level: "warn", stage: "sweep_error", error: errText(err) });
    });
  }, intervalMs);
  logEvent("reconcile", { stage: "started", intervalMs });
}

export function stopReconcileSweep(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export async function reconcileSweep(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = new Date();
    // pending 心跳窗口 = 清扫间隔（创建入队失败/派发丢失的行，一个周期后即可被兜住）
    const pendingCutoff = new Date(now.getTime() - getSetting("worker.zombie_scan_interval_seconds") * 1000);
    const leaseCutoff = stuckLeaseCutoff(now);
    const candidates = await findReconcileCandidates(pendingCutoff, leaseCutoff, now);
    const all = [
      ...candidates.pendingStaleIds,
      ...candidates.executionExpiredIds,
      ...candidates.pollOverdueIds,
    ];
    if (all.length === 0) return;

    let reactivated = 0;
    for (const taskId of all) {
      try {
        const result = await reactivateTask(taskId);
        if (result !== "skipped") reactivated++;
      } catch (err: unknown) {
        // 单行失败不阻断本轮：下一周期该行仍满足候选条件，幂等重扫
        logEvent("reconcile", {
          level: "warn",
          stage: "reactivate_failed",
          taskId,
          error: errText(err),
        });
      }
    }
    logEvent("reconcile", { stage: "swept", candidates: all.length, reactivated });
  } finally {
    sweeping = false;
  }
}
