/**
 * 异步任务恢复轮询。
 * Worker 重启后继续轮询已有 upstreamTaskId 的任务，直至终态或超时。
 */

import { logEvent } from "@server/core/logger/utils";
import { logger } from "@server/core/logger";
import { getConfig } from "@server/core/config";
import { getProvider } from "@server/crud/model-config";
import { getProtocol } from "@server/services/protocols/base";
import type { PollResult } from "@server/services/protocols/base";
import { resolveProviderEndpoints, hostFromBaseUrl } from "@server/services/model-config";
import { downloadAndSave } from "@server/services/storage/download";
import { fetchWithTimeout } from "@server/core/http-client";
import { updateTaskStatus, isTaskCancelled } from "@server/crud/task";
import type { HydratedGenerationTask } from "@server/crud/task";
import type { StopSignal } from "./loop";

/**
 * 恢复异步任务轮询（Worker 重启时调用）。
 * 使用 undici.request 替代 fetch 确保代理和超时生效。
 */
export function resumeAsyncPolling(task: HydratedGenerationTask, stopSignal: StopSignal): void {
  const taskId = task.id;
  const upstreamTaskId = task.upstreamTaskId!;

  logEvent("resume_poll", {
    stage: "start",
    taskId,
    upstreamTaskId,
    capability: task.type,
  });

  // 异步执行，不阻塞主循环
  _doResumePoll(task, stopSignal).catch((err) => {
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
    await _failTask(taskId, `Failed to resume polling: ${(err as Error).message}`);
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

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (stopSignal.stopped) {
      logEvent("resume_poll", { stage: "stopped_by_signal", taskId, attempt });
      return;
    }

    // 检查取消
    if (await _checkCancelled(taskId)) {
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

        // 下载结果落盘
        const resultUrls: string[] = [];
        for (const url of parsed.urls) {
          try {
            const key = await downloadAndSave(url, task.userId, taskId);
            if (key) resultUrls.push(key);
          } catch (err) {
            logger.error({ err, taskId }, "Resume poll download failed");
          }
        }

        await updateTaskStatus(taskId, {
          status: "completed",
          resultUrls,
          completedAt: new Date(),
        });
        return;
      }

      if (parsed.status === "failed") {
        await _failTask(taskId, parsed.error ?? "Upstream task failed");
        return;
      }

      // pending: continue
    } catch (err: unknown) {
      const e = err as Error & { code?: string; name?: string };
      logger.warn({
        taskId,
        attempt: attempt + 1,
        err: e.message?.slice(0, 120) || e.code || e.name || String(err).slice(0, 120),
      }, "resume poll error");
    }
  }

  // 超时
  await _failTask(taskId, `异步轮询超时（upstream_task_id=${upstreamTaskId}）`);
}

async function _checkCancelled(taskId: string): Promise<boolean> {
  return isTaskCancelled(taskId);
}

async function _failTask(taskId: string, error: string): Promise<void> {
  try {
    await updateTaskStatus(taskId, {
      status: "failed",
      error,
      completedAt: new Date(),
    });
  } catch (err) {
    logger.error({ err, taskId }, "Failed to update failed task");
  }
}
