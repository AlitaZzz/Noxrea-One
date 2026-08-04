// ── TaskManager：同步优先异步兜底（对齐 backend/app/services/tasks/manager.py） ──

import { getConfig } from "@server/core/config";
import { logEvent } from "@server/core/logger/utils";
import { logger } from "@server/core/logger";
import { fetchWithTimeout, getWorkerApiTimeout } from "@server/core/http-client";
import { updateTaskStatus, isTaskCancelled, getTaskStatus } from "@server/crud/task";
import type { ProtocolService, PollResult } from "@server/services/protocols/base";

// ── 导出类型 ──────────────────────────────────────────────────

export interface SubmitAndWaitResult {
  status: "completed" | "failed";
  urls: string[];
  text?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface SubmitAndWaitInput {
  taskId: string;
  userId: number;
  protocol: ProtocolService;
  capability: string;
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  /** 渠道配置（含 protocol.endpoints） */
  channelConfig?: Record<string, unknown>;
  /** 构建请求的回调（capability 自己决定怎么发） */
  buildRequest: () => { url: string; method: string; headers: Record<string, string>; body?: unknown };
  /** 解析同步响应 */
  parseResponse: (data: unknown) => { urls: string[]; text?: string };
  pollInterval?: number;
  maxPollAttempts?: number;
  initialDelay?: number;
}

// ── 导出（供 executor 使用） ──────────────────────────────────

export interface PollOptions {
  maxAttempts?: number;
  initialDelay?: number;
  pollInterval?: number;
  taskId?: string;
}

/**
 * 通用异步轮询器（兼容旧接口，内部使用）
 */
export async function pollUntilResult<T>(
  pollFn: () => Promise<T | null>,
  options: PollOptions = {}
): Promise<T | null> {
  const cfg = getConfig();
  const maxAttempts = options.maxAttempts ?? cfg.WORKER_ASYNC_POLL_MAX_ATTEMPTS;
  const initialDelay = (options.initialDelay ?? cfg.WORKER_ASYNC_POLL_INITIAL_DELAY) * 1000;
  const pollInterval = (options.pollInterval ?? cfg.WORKER_ASYNC_POLL_INTERVAL) * 1000;
  const taskId = options.taskId;

  await new Promise((r) => setTimeout(r, initialDelay));

  for (let i = 0; i < maxAttempts; i++) {
    if (taskId && i % 5 === 0) {
      try {
        const status = await getTaskStatus(taskId);
        if (status === "cancelled") {
          logEvent("poll", { stage: "cancelled", taskId });
          return null;
        }
      } catch { /* ignore */ }
    }

    const result = await pollFn();
    if (result !== null) return result;

    const delay = i < 30 ? Math.min(pollInterval, 3000) : Math.min(pollInterval * 2, 6000);
    await new Promise((r) => setTimeout(r, delay));
  }

  return null;
}

// ── 核心：submit_and_wait ────────────────────────────────────

/**
 * 同步优先异步兜底：提交上游请求，自动判断/轮询。
 * 对齐 Python TaskManager.submit_and_wait()
 *
 * 流程：
 * 1. 提交 HTTP 请求
 * 2. 尝试同步提取结果（parseResponse）
 * 3. 同步无结果 → 尝试 extractTaskId → 进入轮询
 * 4. 都没有 → 失败
 */
export async function submitAndWait(input: SubmitAndWaitInput): Promise<SubmitAndWaitResult> {
  const cfg = getConfig();
  const {
    taskId,
    protocol,
    capability,
    baseUrl,
    apiKey,
    channelConfig,
    pollInterval = cfg.WORKER_ASYNC_POLL_INTERVAL,
    maxPollAttempts = cfg.WORKER_ASYNC_POLL_MAX_ATTEMPTS,
    initialDelay = cfg.WORKER_ASYNC_POLL_INITIAL_DELAY,
  } = input;

  // 1. 提交上游请求
  const req = input.buildRequest();
  let data: unknown;

  try {
    const response = await fetchWithTimeout(req.url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.body ? JSON.stringify(req.body) : undefined,
      timeoutMs: getWorkerApiTimeout(),
    });

    if (!response.ok) {
      // HTTP 错误：尝试从错误响应提取 task_id
      let errData: unknown = {};
      try {
        errData = await response.json();
      } catch {
        try {
          errData = { raw: await response.text() };
        } catch { /* ignore */ }
      }

      const extractedId = protocol.extractTaskId?.(errData, channelConfig);
      if (extractedId) {
        // 检查是否已被取消
        if (await _checkCancelled(taskId)) {
          return { status: "failed", urls: [], error: "Cancelled" };
        }
        return await _poll({
          taskId, protocol, capability, baseUrl, apiKey,
          upstreamTaskId: extractedId,
          channelConfig,
          pollInterval, maxPollAttempts, initialDelay,
        });
      }

      const detail = typeof errData === "object" ? JSON.stringify(errData).slice(0, 300) : String(errData).slice(0, 300);
      return {
        status: "failed",
        urls: [],
        error: `Upstream returned HTTP ${response.status} — ${detail}`,
      };
    }

    data = await response.json();
    logger.debug({ taskId, keys: Object.keys(data as object) }, "upstream response");
  } catch (err: unknown) {
    const e = err as Error & { code?: string };
    if (e.name === "TimeoutError" || e.code === "UND_ERR_HEADERS_TIMEOUT") {
      return { status: "failed", urls: [], error: "API call timed out" };
    }
    return { status: "failed", urls: [], error: e.message?.slice(0, 500) ?? "Unknown error" };
  }

  // 2. 尝试同步提取结果
  const result = input.parseResponse(data);
  if (result.urls.length > 0 || result.text) {
    logEvent("taskmgr", { stage: "sync_completed", taskId, urls: result.urls.length, hasText: !!result.text });
    return { status: "completed", urls: result.urls, text: result.text };
  }

  // 3. 尝试提取异步 task_id → 进入轮询
  const upstreamTaskId = protocol.extractTaskId?.(data, channelConfig);
  if (upstreamTaskId) {
    logEvent("taskmgr", { stage: "async_detected", taskId, upstreamTaskId });
    if (await _checkCancelled(taskId)) {
      return { status: "failed", urls: [], error: "Cancelled" };
    }
    return await _poll({
      taskId, protocol, capability, baseUrl, apiKey,
      upstreamTaskId,
      channelConfig,
      pollInterval, maxPollAttempts, initialDelay,
    });
  }

  // 4. 两者都无 → 失败
  const sample = JSON.stringify(data).slice(0, 500);
  return {
    status: "failed",
    urls: [],
    error: `Upstream returned neither result nor task_id; response=${sample}`,
    metadata: { raw_sample: sample },
  };
}

// ── 内部轮询 ──────────────────────────────────────────────────

interface PollInput {
  taskId: string;
  protocol: ProtocolService;
  capability: string;
  baseUrl: string;
  apiKey: string;
  upstreamTaskId: string;
  channelConfig?: Record<string, unknown>;
  pollInterval: number;
  maxPollAttempts: number;
  initialDelay: number;
}

async function _poll(input: PollInput): Promise<SubmitAndWaitResult> {
  const {
    taskId, protocol, capability, baseUrl, apiKey,
    upstreamTaskId, channelConfig, pollInterval, maxPollAttempts, initialDelay,
  } = input;

  // 若协议完全不支持轮询，直接失败，避免无限 pending
  if (!protocol.buildPollUrl && !protocol.parsePollResponse) {
    logEvent("taskmgr", {
      stage: "poll_no_support",
      taskId,
      upstreamTaskId,
      protocol: (protocol as unknown as Record<string, unknown>).name,
    });
    return {
      status: "failed",
      urls: [],
      error: `Protocol does not support polling for upstream task ${upstreamTaskId}`,
    };
  }

  const pollUrl = protocol.buildPollUrl?.(baseUrl, upstreamTaskId, channelConfig)
    ?? `${baseUrl}/tasks/${upstreamTaskId}`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  logEvent("taskmgr", {
    stage: "poll_start",
    taskId,
    upstreamTaskId,
    pollUrl,
    maxAttempts: maxPollAttempts,
    interval: pollInterval,
  });

  // 保存 upstream_task_id
  try {
    await updateTaskStatus(taskId, { status: "processing", upstreamTaskId });
  } catch { /* non-critical */ }

  // 初始等待
  if (initialDelay > 0) {
    await new Promise((r) => setTimeout(r, initialDelay * 1000));
  }

  let lastPollData: unknown;

  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    // 每次轮询前都检查取消状态
    if (await _checkCancelled(taskId)) {
      logEvent("taskmgr", { stage: "poll_cancelled", taskId, attempt: attempt + 1 });
      return { status: "failed", urls: [], error: "Cancelled" };
    }

    // 第一次不延迟，后续按 pollInterval 间隔
    if (attempt > 0) {
      const delay = attempt >= 60 ? pollInterval * 2 : pollInterval;
      await new Promise((r) => setTimeout(r, delay * 1000));
    }

    try {
      logEvent("taskmgr", { stage: "poll_attempt", taskId, attempt: attempt + 1, pollUrl });
      const pollResp = await fetchWithTimeout(pollUrl, {
        headers,
        scene: "poll",
      });
      logEvent("taskmgr", { stage: "poll_response", taskId, attempt: attempt + 1, status: pollResp.status });

      if (!pollResp.ok) {
        logger.warn({ taskId, attempt: attempt + 1, status: pollResp.status }, "poll bad status");
        continue;
      }

      const pollData = await pollResp.json();
      logEvent("taskmgr", { stage: "poll_body", taskId, attempt: attempt + 1, body: JSON.stringify(pollData) });
      lastPollData = pollData;

      const parsed: PollResult = protocol.parsePollResponse?.(pollData)
        ?? { status: "pending", urls: [] };
      logEvent("taskmgr", {
        stage: "poll_parsed",
        taskId,
        attempt: attempt + 1,
        status: parsed.status,
        urls: parsed.urls.length,
        error: parsed.error,
      });

      if (parsed.status === "completed") {
        logEvent("taskmgr", {
          stage: "poll_completed",
          taskId,
          attempt: attempt + 1,
          urls: parsed.urls,
          text: parsed.text,
        });
        return { status: "completed", urls: parsed.urls, text: parsed.text };
      }

      if (parsed.status === "failed") {
        logEvent("taskmgr", {
          stage: "poll_upstream_failed",
          taskId,
          attempt: attempt + 1,
          error: parsed.error,
        });
        return { status: "failed", urls: [], error: parsed.error ?? "Upstream task failed" };
      }

      // pending: continue
    } catch (err: unknown) {
      const e = err as Error & { code?: string; name?: string };
      logger.warn({
        taskId,
        attempt: attempt + 1,
        err: e.message?.slice(0, 120) || e.code || e.name || String(err).slice(0, 120),
      }, "poll error");
    }
  }

  // 超时
  const lastInfo = lastPollData ? ` - 上游最后返回: ${JSON.stringify(lastPollData)}` : "";
  return {
    status: "failed",
    urls: [],
    error: `异步轮询超时（upstream_task_id=${upstreamTaskId}）${lastInfo}`,
  };
}

// ── 取消检查 ──────────────────────────────────────────────────

async function _checkCancelled(taskId: string): Promise<boolean> {
  return isTaskCancelled(taskId);
}
