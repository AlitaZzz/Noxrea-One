/**
 * 任务管理器。
 * 提交生成任务并优先同步等待，超时则转为异步轮询兜底。
 */

import { getConfig } from "@server/core/config";
import { logEvent, errText } from "@server/core/logger/utils";
import { logger } from "@server/core/logger";
import { fetchWithTimeout, getWorkerApiTimeout } from "@server/core/http-client";
import { extractUpstreamMessage } from "@server/services/tasks/failure";
import {
  markTaskProcessing,
  isTaskCancelled,
  touchTaskHeartbeat,
  TASK_HEARTBEAT_INTERVAL_MS,
} from "@server/crud/task";
import type { ProtocolService, PollResult } from "@server/services/protocols/base";

export interface SubmitAndWaitResult {
  status: "completed" | "failed";
  urls: string[];
  text?: string;
  error?: string;
  /**
   * 失败分类：仅在我们自己能判定原因时给出（超时 / 网络 / 上游 HTTP 等），
   * 上游自带文案的场景留空，由前端原样展示原文。
   */
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

export interface SubmitAndWaitInput {
  taskId: string;
  userId: number;
  /** 认领时间戳：markTaskProcessing 用它校验本执行者仍持有任务所有权 */
  startedAt: Date | null;
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

// 核心：submit_and_wait

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

  // 从请求体提取 model，供轮询 URL 的 {model} 占位符使用
  const reqModel = (req.body as Record<string, unknown> | undefined)?.model;
  const model = typeof reqModel === "string" ? reqModel : undefined;

  // 开始发送请求（同步阻塞前打印，便于在等待期间观察出参）
  logEvent("taskmgr", {
    banner: true,
    bannerTitle: "开始发送请求",
    stage: "request_preparing",
    taskId,
    url: req.url,
    method: req.method,
    body: req.body,
  });

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

      const extractedId = protocol.extractTaskId?.(errData, channelConfig, capability);
      if (extractedId) {
        // 检查是否已被取消
        if (await isTaskCancelled(taskId)) {
          return {
            status: "failed",
            urls: [],
            error: "Cancelled",
            errorCode: "generation.cancelled",
          };
        }
        return await _poll({
          taskId, startedAt: input.startedAt,
          protocol, capability, baseUrl, apiKey,
          upstreamTaskId: extractedId,
          channelConfig,
          model,
          pollInterval, maxPollAttempts, initialDelay,
        });
      }

      // 原始响应体只进日志；对外只回传上游自带的可读文案，取不到时退化为状态码
      logEvent("taskmgr", {
        level: "warn",
        stage: "upstream_http_error",
        taskId,
        status: response.status,
        body: JSON.stringify(errData).slice(0, 500),
      });
      const upstreamMsg = extractUpstreamMessage(errData);
      return {
        status: "failed",
        urls: [],
        // 上游给出可读文案时原样展示；否则回退错误码，由前端本地化
        // （状态码已包含在 error 文案中，供用户报障时查看）
        error: upstreamMsg || `HTTP ${response.status}`,
        errorCode: upstreamMsg ? undefined : "generation.upstream_http_error",
      };
    }

    data = await response.json();
    logger.debug({ taskId, keys: Object.keys(data as object) }, "upstream response");
  } catch (err: unknown) {
    const e = err as Error & { code?: string; cause?: { code?: string; message?: string } };
    if (e.name === "TimeoutError" || e.code === "UND_ERR_HEADERS_TIMEOUT") {
      return {
        status: "failed",
        urls: [],
        error: "API call timed out",
        errorCode: "generation.timeout",
      };
    }
    const cause = e.cause;
    const detail = cause
      ? `${e.message} [cause: ${cause.code ?? cause.message}]`
      : (e.message ?? "Unknown error");
    logEvent("taskmgr", { level: "warn", stage: "upstream_network_error", taskId, error: detail });
    return {
      status: "failed",
      urls: [],
      error: detail.slice(0, 200),
      errorCode: "generation.network_error",
    };
  }

  // 2. 尝试同步提取结果
  const result = input.parseResponse(data);
  if (result.urls.length > 0 || result.text) {
    logEvent("taskmgr", {
      banner: true,
      bannerTitle: "已获取生成结果",
      stage: "sync_completed",
      taskId,
      urls: result.urls.length,
      hasText: !!result.text,
    });
    return { status: "completed", urls: result.urls, text: result.text };
  }

  // 3. 尝试提取异步 task_id → 进入轮询
  const upstreamTaskId = protocol.extractTaskId?.(data, channelConfig, capability);
  if (upstreamTaskId) {
    logEvent("taskmgr", {
      stage: "upstream_response",
      taskId,
      body: data,
      maxLen: Infinity,
    });
    const pollUrlPreview = protocol.buildPollUrl?.(baseUrl, upstreamTaskId, channelConfig, capability, model)
      ?? `${baseUrl}/tasks/${upstreamTaskId}`;
    logEvent("taskmgr", {
      banner: true,
      bannerTitle: "已获取任务 ID，开始轮询",
      stage: "polling",
      taskId,
      upstreamTaskId,
      pollUrl: pollUrlPreview,
    });
    if (await isTaskCancelled(taskId)) {
      return { status: "failed", urls: [], error: "Cancelled" };
    }
    return await _poll({
      taskId, startedAt: input.startedAt,
      protocol, capability, baseUrl, apiKey,
      upstreamTaskId,
      channelConfig,
      model,
      pollInterval, maxPollAttempts, initialDelay,
    });
  }

  // 4. 两者都无 → 失败
  // 与 HTTP 错误分支保持一致：优先回传上游自带的可读文案（如 {"error":{"message":"..."}} 中的 message），
  // 取不到时回退错误码由前端本地化。整段响应体只进日志与 metadata，
  // 不再拼进 error——否则用户看到的是被截断的 JSON 碎片而非真正的失败原因。
  const sample = JSON.stringify(data).slice(0, 500);
  logEvent("taskmgr", {
    level: "warn",
    stage: "upstream_no_result",
    taskId,
    body: sample,
  });
  const upstreamMsg = extractUpstreamMessage(data);
  return {
    status: "failed",
    urls: [],
    error: upstreamMsg || "Upstream returned neither result nor task_id",
    errorCode: upstreamMsg ? undefined : "generation.upstream_no_result",
    metadata: { raw_sample: sample },
  };
}

// 内部轮询

interface PollInput {
  taskId: string;
  startedAt: Date | null;
  protocol: ProtocolService;
  capability: string;
  baseUrl: string;
  apiKey: string;
  upstreamTaskId: string;
  channelConfig?: Record<string, unknown>;
  model?: string;
  pollInterval: number;
  maxPollAttempts: number;
  initialDelay: number;
}

async function _poll(input: PollInput): Promise<SubmitAndWaitResult> {
  const {
    taskId, startedAt, protocol, capability, baseUrl, apiKey,
    upstreamTaskId, channelConfig, model, pollInterval, maxPollAttempts, initialDelay,
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

  const pollUrl = protocol.buildPollUrl?.(baseUrl, upstreamTaskId, channelConfig, capability, model)
    ?? `${baseUrl}/tasks/${upstreamTaskId}`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  logEvent("taskmgr", {
    level: "debug",
    stage: "poll_start",
    taskId,
    upstreamTaskId,
    pollUrl,
    maxAttempts: maxPollAttempts,
    interval: pollInterval,
  });

  // 保存 upstream_task_id（带 processing + startedAt 守卫：期间被取消、被僵尸
  // 清理重置、或已被重新认领时写入被丢弃，不会污染新所有者的状态）
  // 守卫拒绝的真实原因（用户取消 / 僵尸重置 / 已被重新认领）在此无法区分，
  // 不硬编码 cancelled 误导遥测；该结果只进执行日志，不会写库
  const ownershipLost = (): SubmitAndWaitResult => ({
    status: "failed",
    urls: [],
    error: "Task ownership lost",
  });
  const logWriteFailed = (attempt: number | string, err: unknown) => {
    // 写库失败不能静默吞掉：upstreamTaskId 落不了盘，进程重启后
    // recoverProcessingTasks 会把任务当作同步任务重新提交上游（重复生成、重复计费）
    logEvent("taskmgr", {
      level: "warn",
      stage: "processing_write_failed",
      taskId,
      attempt,
      error: errText(err),
    });
  };

  let persisted = false;
  let persistPending = false;
  for (let attempt = 1; attempt <= 3 && !persisted; attempt++) {
    let threw = false;
    try {
      persisted = await markTaskProcessing(taskId, upstreamTaskId, startedAt);
    } catch (err: unknown) {
      threw = true;
      logWriteFailed(attempt, err);
    }
    if (persisted) break;
    if (!threw) {
      // 守卫拒绝 = 任务已离开本次认领，本轮执行者已失去所有权，继续轮询上游
      // 只会产生无人接收的结果。不能在这里写终态：重置/重认领场景下任务属于
      // 新执行者，failTask 的所有权守卫会拒绝本次写入。
      logEvent("taskmgr", { stage: "skipped_processing_write", taskId });
      return ownershipLost();
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 200 * attempt));
  }
  if (!persisted) {
    // 重试耗尽仍写不进去——不判死：上游已受理（必然计费），此刻判死等于让用户
    // 付费却拿不到结果。upstreamTaskId 保留在内存中继续轮询，随心跳周期重试落盘；
    // DB 恢复后落盘成功，进程重启不再重复提交。整个轮询期都失败时重启仍会重新
    // 提交上游（at-least-once 的剩余窗口），相比判死丢弃已计费结果优先保交付。
    persistPending = true;
    logEvent("taskmgr", { level: "warn", stage: "processing_persist_deferred", taskId });
  }

  // 初始等待
  if (initialDelay > 0) {
    await new Promise((r) => setTimeout(r, initialDelay * 1000));
  }

  let lastPollData: unknown;

  let lastHeartbeatAt = Date.now();

  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    // 心跳：僵尸清理以 updatedAt 判定任务卡死，而视频生成的轮询常持续十几分钟。
    // 不持续推进 updatedAt，长任务就会被误判为僵尸、重置重跑并再次提交到上游，
    // 造成重复生成与重复计费
    if (Date.now() - lastHeartbeatAt >= TASK_HEARTBEAT_INTERVAL_MS) {
      lastHeartbeatAt = Date.now();
      // persistPending 时由下方重试推进 updatedAt（仅重试成功时；重试也失败则
      // 由 catch 里的裸心跳兜底再试一次，避免 updatedAt 冻结被清理误重置）
      if (!persistPending) void touchTaskHeartbeat(taskId, startedAt);
      // 落盘被推迟的补投递：与心跳同周期重试（重试失败不影响主轮询）。
      // 守卫拒绝 = 任务已离开本次认领，同 persist 首次写入的处理
      if (persistPending) {
        try {
          if (await markTaskProcessing(taskId, upstreamTaskId, startedAt)) {
            persistPending = false;
            logEvent("taskmgr", { stage: "processing_persist_recovered", taskId });
          } else {
            logEvent("taskmgr", { stage: "skipped_processing_write", taskId });
            return ownershipLost();
          }
        } catch (err: unknown) {
          logWriteFailed("heartbeat", err);
          void touchTaskHeartbeat(taskId, startedAt);
        }
      }
    }

    // 每次轮询前都检查取消状态（isTaskCancelled 自身吞 DB 错误视为未取消）
    if (await isTaskCancelled(taskId)) {
      logEvent("taskmgr", { stage: "poll_cancelled", taskId, attempt: attempt + 1 });
      return { status: "failed", urls: [], error: "Cancelled" };
    }

    // 第一次不延迟，后续按 pollInterval 间隔
    if (attempt > 0) {
      const delay = attempt >= 60 ? pollInterval * 2 : pollInterval;
      await new Promise((r) => setTimeout(r, delay * 1000));
    }

    try {
      logEvent("taskmgr", { level: "debug", stage: "poll_attempt", taskId, attempt: attempt + 1, pollUrl });
      const pollResp = await fetchWithTimeout(pollUrl, {
        headers,
        scene: "poll",
      });
      logEvent("taskmgr", { level: "debug", stage: "poll_response", taskId, attempt: attempt + 1, status: pollResp.status });

      if (!pollResp.ok) {
        // 永久性 4xx（除 408/425/429 外）：重试无意义，直接失败
        const permanent = pollResp.status >= 400 && pollResp.status < 500 &&
          ![408, 425, 429].includes(pollResp.status);
        if (permanent) {
          logger.warn({ taskId, attempt: attempt + 1, status: pollResp.status }, "poll permanent error");
          return { status: "failed", urls: [], error: `轮询失败（HTTP ${pollResp.status}），upstream_task_id=${upstreamTaskId}` };
        }
        logger.warn({ taskId, attempt: attempt + 1, status: pollResp.status }, "poll bad status");
        continue;
      }

      const pollData = await pollResp.json();
      logEvent("taskmgr", { level: "debug", stage: "poll_body", taskId, attempt: attempt + 1, body: JSON.stringify(pollData) });
      lastPollData = pollData;

      const parsed: PollResult = protocol.parsePollResponse?.(pollData)
        ?? { status: "pending", urls: [] };
      logEvent("taskmgr", {
        level: "debug",
        stage: "poll_parsed",
        taskId,
        attempt: attempt + 1,
        status: parsed.status,
        urls: parsed.urls.length,
        error: parsed.error,
      });

      if (parsed.status === "completed") {
        logEvent("taskmgr", {
          level: "debug",
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
      logger.warn({ taskId, attempt: attempt + 1, err: errText(err) }, "poll error");
    }
  }

  // 超时
  const lastInfo = lastPollData ? ` - 上游最后返回: ${JSON.stringify(lastPollData)}` : "";
  return {
    status: "failed",
    urls: [],
    error: `异步轮询超时（upstream_task_id=${upstreamTaskId}）${lastInfo}`,
    // 超时 ≠ 上游失败：上游可能仍在生成。给专门错误码，前端据此提示用户
    errorCode: "generation.poll_timeout",
  };
}
