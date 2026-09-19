/**
 * 异步任务恢复轮询。
 * Worker 重启后继续轮询已有 upstreamTaskId 的任务，直至终态或超时。
 */

import { logEvent, errText } from "@server/core/logger/utils";
import { logger } from "@server/core/logger";
import { getConfig } from "@server/core/config";
import { getProvider } from "@server/crud/model-config";
import { getProtocol } from "@server/services/protocols/base";
import type { PollResult } from "@server/services/protocols/base";
import { resolveProviderEndpoints, hostFromBaseUrl } from "@server/services/model-config";
import { fetchWithTimeout } from "@server/core/http-client";
import {
  safeCompleteTask,
  safeFailTask,
  isTaskCancelled,
  touchTaskHeartbeat,
  TASK_HEARTBEAT_INTERVAL_MS,
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
    protocol = getProtocol(protoName);
    if (!protocol?.buildPollUrl) throw new Error("Protocol does not support polling");

    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const model = task.model ?? "";
    const endpoints = model
      ? resolveProviderEndpoints(hostFromBaseUrl(baseUrl), model, task.type)
      : undefined;
    const endpointCfg = endpoints ? { protocol: { endpoints } } : undefined;
    pollUrl = protocol.buildPollUrl(baseUrl, upstreamTaskId, endpointCfg, task.type, model);
  } catch (err: unknown) {
    await _failTask(task, `Failed to resume polling: ${errText(err)}`);
    return;
  }

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

  let lastHeartbeatAt = Date.now();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 心跳：与 manager 的 _poll 同理——僵尸清理以 updatedAt 判定卡死，
    // 恢复的长任务若不心跳，会再次被误判并重新提交到上游
    if (Date.now() - lastHeartbeatAt >= TASK_HEARTBEAT_INTERVAL_MS) {
      lastHeartbeatAt = Date.now();
      void touchTaskHeartbeat(taskId, task.startedAt);
    }

    if (stopSignal.stopped) {
      logEvent("resume_poll", { stage: "stopped_by_signal", taskId, attempt });
      return;
    }

    // 检查取消（isTaskCancelled 自身吞 DB 错误视为未取消，防止抖动杀死整个恢复轮询）
    if (await isTaskCancelled(taskId)) {
      logEvent("resume_poll", { stage: "cancelled", taskId, attempt });
      return;
    }

    // 延迟（第一次不延迟）
    if (attempt > 0) {
      const delay = attempt >= 60 ? pollInterval * 2 : pollInterval;
      await new Promise((r) => setTimeout(r, delay * 1000));
    }

    try {
      logEvent("resume_poll", { stage: "poll_attempt", taskId, attempt: attempt + 1, pollUrl });
      const pollResp = await fetchWithTimeout(pollUrl, {
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        scene: "poll",
      });
      logEvent("resume_poll", { stage: "poll_response", taskId, attempt: attempt + 1, status: pollResp.status });

      if (!pollResp.ok) {
        logger.warn({ taskId, attempt: attempt + 1, status: pollResp.status }, "resume poll bad status");
        continue;
      }

      const raw = await pollResp.json();
      logEvent("resume_poll", { stage: "poll_body", taskId, attempt: attempt + 1, body: JSON.stringify(raw) });
      const parsed: PollResult = protocol?.parsePollResponse
        ? protocol.parsePollResponse(raw)
        : { status: "pending", urls: [] };

      if (parsed.status === "completed") {
        logEvent("resume_poll", { stage: "completed", taskId, attempt: attempt + 1, urls: parsed.urls.length });

        // 下载落盘并保持心跳（与 executor 同理，防止僵尸清理误判重跑）
        const resultUrls = await downloadResultsWithHeartbeat(
          taskId,
          task.userId,
          parsed.urls,
          "Resume poll download failed",
          task.startedAt
        );

        // safeCompleteTask 自身不抛：守卫拒绝/写库失败均已记日志，任务交由
        // 僵尸清理兜底，不会让 DB 错误冒充生成失败
        await safeCompleteTask(taskId, { resultUrls }, { startedAt: task.startedAt });
        return;
      }

      if (parsed.status === "failed") {
        await _failTask(task, parsed.error ?? "Upstream task failed");
        return;
      }

      // pending: continue
    } catch (err: unknown) {
      logger.warn({ taskId, attempt: attempt + 1, err: errText(err) }, "resume poll error");
    }
  }

  // 超时：与首次提交轮询超时同码，前端据此提示用户
  await _failTask(
    task,
    `异步轮询超时（upstream_task_id=${upstreamTaskId}）`,
    "generation.poll_timeout",
  );
}

function _failTask(
  task: HydratedGenerationTask,
  error: string,
  errorCode?: string
): Promise<void> {
  // safeFailTask 自身不抛：DB 抖动记日志返回 null，所有权守卫拒绝记 skipped_terminal_write
  return safeFailTask(task.id, { error, errorCode }, { startedAt: task.startedAt }).then(() => undefined);
}
