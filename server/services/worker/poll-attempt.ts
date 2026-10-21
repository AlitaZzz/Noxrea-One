/**
 * 单次轮询尝试（specs/task-queue-bullmq.md 规则 1：轮询 tick 化）。
 * 处理一个已受理（有 upstreamTaskId）任务的当次 tick：轮询上游一次，
 * 按结果收口终态 / 推进下一次 tick / 预算耗尽重入队。
 * 轮询段不持有租约（对上游只读 GET），tick job 即存活信号。
 */

import { logEvent } from "@server/core/logger/utils";
import { getSetting } from "@server/core/settings";
import { getProvider } from "@server/crud/model-config";
import { getProtocol } from "@server/services/protocols/base";
import { pollUpstreamOnce } from "@server/services/tasks/poll-loop";
import { resolveProviderEndpoints, hostFromBaseUrl } from "@server/services/model-config";
import { stripTrailingSlash } from "@noxrea/shared/url";
import {
  safeFailTask,
  requeueProcessingAsyncTask,
  deferPollTick,
} from "@server/crud/task";
import { deferActiveTickOrThrow, type TickDeferContext } from "./queue";
import { finalizeGeneratedResult } from "./download-results";

import type { HydratedGenerationTask } from "@server/crud/task";

/** 长轮询尾部降频阈值：达到该尝试次数后轮询间隔翻倍（慢任务减少无效请求频率） */
const POLL_BACKOFF_TRIGGER_ATTEMPT = 60;

export async function runPollAttempt(
  task: HydratedGenerationTask,
  signal: AbortSignal,
  deferCtx: TickDeferContext
): Promise<void> {
  const taskId = task.id;
  const upstreamTaskId = task.upstreamTaskId!;

  // 构建轮询请求（供应商/协议配置缺失属确定性失败，直接终态）
  let pollUrl: string;
  let headers: Record<string, string>;
  let protocol: ReturnType<typeof getProtocol>;
  try {
    const providerId = task.config.providerId;
    if (typeof providerId !== "number") {
      throw new Error("providerId not found in task config");
    }
    const provider = await getProvider(providerId, task.userId);
    if (!provider) throw new Error(`Provider ${providerId} not found`);

    const protoName = task.protocol ?? provider.protocol ?? "openai";
    const proto = getProtocol(protoName);
    if (!proto?.buildPollUrl) throw new Error("Protocol does not support polling");
    protocol = proto;

    const baseUrl = stripTrailingSlash(provider.baseUrl);
    const model = task.model ?? "";
    const endpoints = model
      ? resolveProviderEndpoints(hostFromBaseUrl(baseUrl), model, task.type)
      : undefined;
    const endpointCfg = endpoints ? { protocol: { endpoints } } : undefined;
    pollUrl = proto.buildPollUrl(baseUrl, upstreamTaskId, endpointCfg, task.type, model);
    headers = {
      "Content-Type": "application/json",
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    };
  } catch (err: unknown) {
    await safeFailTask(taskId, {
      error: `Failed to poll upstream task: ${(err as Error).message}`,
    }, { startedAt: task.startedAt });
    return;
  }

  // 停机中止（drain 超时）：不轮询也不调度，重启后由 stalled 重跑 / 清扫收口
  if (signal.aborted) {
    logEvent("poll_tick", { stage: "aborted_before_poll", taskId });
    return;
  }

  const outcome = await pollUpstreamOnce({
    taskId,
    upstreamTaskId,
    pollUrl,
    headers,
    protocol,
    signal,
    logChannel: "poll_tick",
  });

  if (outcome.kind === "completed") {
    logEvent("poll_tick", { stage: "completed", taskId, urls: outcome.urls.length });
    // 终态编排单源（与 executor 共用）：下载落盘 → 空结果判失败 → safe 终态
    await finalizeGeneratedResult({
      taskId,
      userId: task.userId,
      startedAt: task.startedAt,
      urls: outcome.urls,
      text: outcome.text,
      logLabel: "Poll download failed",
      logChannel: "poll_tick",
    });
    return;
  }

  if (outcome.kind === "failed") {
    await safeFailTask(taskId, {
      error: outcome.error,
      errorCode: outcome.errorCode,
    }, { startedAt: task.startedAt });
    return;
  }

  // pending / error：上游未到终态（或本轮网络异常）——推进调度。
  // 停机中止（signal 已 abort）：不 defer 不调度，nextPollAt 保持原值（已逾期），
  // 重启后清扫按「tick 逾期 + 无 live job」重激活自愈
  if (signal.aborted) {
    logEvent("poll_tick", { stage: "aborted_after_poll", taskId });
    return;
  }

  const attempt = task.asyncPollAttempts + 1;
  const maxAttempts = getSetting("worker.async_poll_max_attempts");

  if (attempt >= maxAttempts) {
    // 预算耗尽 ≠ 上游失败：重置 pending 重新认领后继续轮询（不重提上游）；
    // retryCount 预算烧完时 requeue 返回 false，才落 poll_timeout 终态
    const lastError = outcome.kind === "error" ? outcome.error : undefined;
    const requeued = await requeueProcessingAsyncTask(
      taskId,
      task.startedAt,
      getSetting("worker.max_retries")
    );
    if (requeued) {
      logEvent("poll_tick", { stage: "poll_exhausted_requeued", taskId, upstreamTaskId });
      // 立即重跑（新轮询会话首轮）：同 job 原位 moveToDelayed(now)——processor 内
      // 同 jobId 必为 active，重激活原语恒 skipped。handler 下次执行读到
      // pending + upstreamTaskId，认领后直入轮询段（绝不重提上游）
      await deferActiveTickOrThrow(deferCtx, taskId, new Date());
      return;
    }
    await safeFailTask(taskId, {
      error: lastError ?? `异步轮询超时（upstream_task_id=${upstreamTaskId}）`,
      errorCode: lastError ? undefined : "generation.poll_timeout",
    }, { startedAt: task.startedAt });
    return;
  }

  // 推进下一次 tick：写 nextPollAt（退避：达到阈值后间隔翻倍）+ 当轮尝试计数，
  // 再将当前 job 原位 moveToDelayed 至 nextPollAt（规则 2 回写：processor 内自调度
  // 不经重激活原语——同 jobId add 在 active 态被 skipped）。defer 被守卫拒绝 =
  // 已失权（任务被取消/重置），不调度
  const interval = getSetting("worker.async_poll_interval_seconds");
  const delaySeconds = attempt >= POLL_BACKOFF_TRIGGER_ATTEMPT ? interval * 2 : interval;
  const nextPollAt = new Date(Date.now() + delaySeconds * 1000);
  const deferred = await deferPollTick(taskId, task.startedAt, nextPollAt, attempt);
  if (!deferred) {
    logEvent("poll_tick", { stage: "defer_ownership_lost", taskId });
    return;
  }
  await deferActiveTickOrThrow(deferCtx, taskId, nextPollAt);
}
