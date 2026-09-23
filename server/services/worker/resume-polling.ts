/**
 * 异步任务恢复轮询。
 * Worker 重启后继续轮询已有 upstreamTaskId 的任务，直至终态或超时。
 */

import { logEvent, errText } from "@server/core/logger/utils";
import { logger } from "@server/core/logger";
import { getConfig } from "@server/core/config";
import { getProvider } from "@server/crud/model-config";
import { getProtocol } from "@server/services/protocols/base";
import type { PollOutcome } from "@server/services/tasks/poll-loop";
import { pollUpstreamTask } from "@server/services/tasks/poll-loop";
import { resolveProviderEndpoints, hostFromBaseUrl } from "@server/services/model-config";
import {
  safeCompleteTask,
  safeFailTask,
  isTaskCancelled,
  touchTaskHeartbeat,
} from "@server/crud/task";
import { downloadResultsWithHeartbeat } from "./download-results";
import type { HydratedGenerationTask } from "@server/crud/task";
import type { StopSignal } from "./loop";

/**
 * 恢复异步任务轮询（Worker 重启时调用）。
 * 使用 undici.request 替代 fetch 确保代理和超时生效。
 */
export function resumeAsyncPolling(
  task: HydratedGenerationTask,
  stopSignal: StopSignal = { stopped: false },
): Promise<void> {
  const taskId = task.id;
  const upstreamTaskId = task.upstreamTaskId!;

  logEvent("resume_poll", {
    stage: "start",
    taskId,
    upstreamTaskId,
    capability: task.type,
  });

  // 返回 Promise 而非 void：启动时调用方 fire-and-forget，执行器里则 await 它，
  // 让「恢复轮询」与「首次提交」一样受并发槽约束，避免恢复的任务绕过并发上限
  return _doResumePoll(task, stopSignal).catch((err) => {
    logger.error({ err, taskId }, "Resume poll failed");
  });
}

async function _doResumePoll(
  task: HydratedGenerationTask,
  stopSignal: StopSignal
): Promise<void> {
  const taskId = task.id;
  const upstreamTaskId = task.upstreamTaskId!;
  const cfg = getConfig();

  // 获取供应商信息
  let pollUrl: string;
  let apiKey: string;
  let protocol: ReturnType<typeof getProtocol>;

  try {
    const providerId = task.config.providerId;
    if (typeof providerId !== "number") {
      throw new Error("providerId not found in task config");
    }
    const provider = await getProvider(providerId, task.userId);
    if (!provider) throw new Error(`Provider ${providerId} not found`);

    apiKey = provider.apiKey;
    const protoName = task.protocol ?? provider.protocol ?? "openai";
    const proto = getProtocol(protoName);
    if (!proto?.buildPollUrl) throw new Error("Protocol does not support polling");
    protocol = proto;

    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const model = task.model ?? "";
    const endpoints = model
      ? resolveProviderEndpoints(hostFromBaseUrl(baseUrl), model, task.type)
      : undefined;
    const endpointCfg = endpoints ? { protocol: { endpoints } } : undefined;
    pollUrl = proto.buildPollUrl(baseUrl, upstreamTaskId, endpointCfg, task.type, model);
  } catch (err: unknown) {
    await _failTask(task, `Failed to resume polling: ${errText(err)}`);
    return;
  }
  // try 内已对 buildPollUrl 做过守卫，运行时不可达；仅为类型收窄
  if (!protocol) return;

  const maxAttempts = cfg.WORKER_ASYNC_POLL_MAX_ATTEMPTS;
  const pollInterval = cfg.WORKER_ASYNC_POLL_INTERVAL;

  logEvent("resume_poll", {
    stage: "polling",
    taskId,
    upstreamTaskId,
    pollUrl,
    maxAttempts,
    interval: pollInterval,
  });

  // 心跳、取消/停机检查、轮询节奏、4xx 判定与协议解析统一走共享轮询核心
  const outcome: PollOutcome = await pollUpstreamTask({
    taskId,
    upstreamTaskId,
    pollUrl,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    protocol,
    pollInterval,
    maxPollAttempts: maxAttempts,
    initialDelay: 0,
    logChannel: "resume_poll",
    onHeartbeat: async () => {
      void touchTaskHeartbeat(taskId, task.startedAt);
      return true;
    },
    shouldStop: async () => stopSignal.stopped || (await isTaskCancelled(taskId)),
  });

  if (outcome.kind === "completed") {
    logEvent("resume_poll", { stage: "completed", taskId, urls: outcome.urls.length });

    // 下载落盘并保持心跳（与 executor 同理，防止僵尸清理误判重跑）
    const resultUrls = await downloadResultsWithHeartbeat(
      taskId,
      task.userId,
      outcome.urls,
      "Resume poll download failed",
      task.startedAt
    );

    // 上游有产物但全部下载失败：显式失败，不能空结果标记 completed
    if (outcome.urls.length > 0 && resultUrls.length === 0) {
      await _failTask(task, "生成结果下载失败", "generation.download_failed");
      return;
    }

    // safeCompleteTask 自身不抛：守卫拒绝/写库失败均已记日志，任务交由
    // 僵尸清理兜底，不会让 DB 错误冒充生成失败
    await safeCompleteTask(taskId, { resultUrls }, { startedAt: task.startedAt });
    return;
  }

  if (outcome.kind === "failed") {
    await _failTask(task, outcome.error, outcome.errorCode);
    return;
  }

  // stopped / lost：任务已取消或停机，终态由取消方/僵尸清理负责，无需写入
}

function _failTask(
  task: HydratedGenerationTask,
  error: string,
  errorCode?: string
): Promise<void> {
  // safeFailTask 自身不抛：DB 抖动记日志返回 null，所有权守卫拒绝记 skipped_terminal_write
  return safeFailTask(task.id, { error, errorCode }, { startedAt: task.startedAt }).then(() => undefined);
}
