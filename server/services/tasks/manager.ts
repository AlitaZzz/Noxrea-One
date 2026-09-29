/**
 * 任务管理器。
 * 提交生成任务并优先同步等待，超时则转为异步轮询兜底。
 */

import { getConfig } from "@server/core/config";
import { logEvent, errText } from "@server/core/logger/utils";
import {
  fetchUpstream,
  httpUpstreamFailure,
  noUpstreamResult,
} from "@server/services/tasks/sync-fetch";
import {
  markTaskProcessing,
  isTaskCancelled,
  touchTaskHeartbeat,
  requeueProcessingAsyncTask,
} from "@server/crud/task";
import { defaultPollUrl, type ProtocolService } from "@server/services/protocols/base";
import { pollUpstreamTask } from "@server/services/tasks/poll-loop";

export interface SubmitAndWaitResult {
  status: "completed" | "failed" | "cancelled" | "requeued";
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
  /** Worker 停机中止信号：中止在途提交请求与轮询 */
  signal?: AbortSignal;
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
    signal,
    pollInterval = cfg.WORKER_ASYNC_POLL_INTERVAL,
    maxPollAttempts = cfg.WORKER_ASYNC_POLL_MAX_ATTEMPTS,
    initialDelay = cfg.WORKER_ASYNC_POLL_INITIAL_DELAY,
  } = input;

  // 1. 提交上游请求
  const req = input.buildRequest();

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

  const outcome = await fetchUpstream(req, taskId, "taskmgr", signal);

  if (outcome.kind === "failure") {
    return { status: "failed", urls: [], error: outcome.error, errorCode: outcome.errorCode };
  }

  if (outcome.kind === "http-error") {
    // 错误体中可能携带 task_id：视为上游已受理，升级为轮询
    const extractedId = protocol.extractTaskId?.(outcome.errData, channelConfig, capability);
    if (extractedId) {
      // 检查是否已被取消
      if (await isTaskCancelled(taskId)) {
        return { status: "cancelled", urls: [] };
      }
      return await _poll({
        taskId, startedAt: input.startedAt,
        protocol, capability, baseUrl, apiKey,
        upstreamTaskId: extractedId,
        channelConfig,
        model,
        pollInterval, maxPollAttempts, initialDelay,
        signal,
      });
    }

    // 原始响应体只进日志；对外只回传上游自带的可读文案，取不到时退化为状态码
    logEvent("taskmgr", {
      level: "warn",
      stage: "upstream_http_error",
      taskId,
      status: outcome.status,
      body: outcome.errText.slice(0, 500),
    });
    const { error, errorCode } = httpUpstreamFailure(outcome.status, outcome.errText);
    return { status: "failed", urls: [], error, errorCode };
  }

  // 2. 尝试同步提取结果
  const data = outcome.data;
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
      ?? defaultPollUrl(baseUrl, upstreamTaskId);
    logEvent("taskmgr", {
      banner: true,
      bannerTitle: "已获取任务 ID，开始轮询",
      stage: "polling",
      taskId,
      upstreamTaskId,
      pollUrl: pollUrlPreview,
    });
    if (await isTaskCancelled(taskId)) {
      return { status: "cancelled", urls: [] };
    }
    return await _poll({
      taskId, startedAt: input.startedAt,
      protocol, capability, baseUrl, apiKey,
      upstreamTaskId,
      channelConfig,
      model,
      pollInterval, maxPollAttempts, initialDelay,
      signal,
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
  return {
    status: "failed",
    urls: [],
    ...noUpstreamResult(data, "Upstream returned neither result nor task_id"),
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
  /** Worker 停机中止信号 */
  signal?: AbortSignal;
}

async function _poll(input: PollInput): Promise<SubmitAndWaitResult> {
  const {
    taskId, startedAt, protocol, capability, baseUrl, apiKey,
    upstreamTaskId, channelConfig, model, pollInterval, maxPollAttempts, initialDelay, signal,
  } = input;
  const cfg = getConfig();

  // 若协议完全不支持轮询，直接失败，避免无限 pending
  if (!protocol.buildPollUrl && !protocol.parsePollResponse) {
    logEvent("taskmgr", {
      stage: "poll_no_support",
      taskId,
      upstreamTaskId,
      protocol: protocol.name,
    });
    return {
      status: "failed",
      urls: [],
      error: `Protocol does not support polling for upstream task ${upstreamTaskId}`,
    };
  }

  const pollUrl = protocol.buildPollUrl?.(baseUrl, upstreamTaskId, channelConfig, capability, model)
    ?? defaultPollUrl(baseUrl, upstreamTaskId);

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
    // 写库失败不能静默吞掉：upstreamTaskId 落不了盘，进程重启后恢复不到轮询态，
    // 任务会被按中断策略判失败（不重新提交，见 recoverProcessingTasks）
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
    // DB 恢复后落盘成功，进程重启走恢复轮询不重提上游。若重启时仍未落盘，任务按
    // 中断策略直接判失败（不重新提交，见 recoverProcessingTasks）——宁可让用户
    // 收到失败文案，也不重复生成、重复计费。
    persistPending = true;
    logEvent("taskmgr", { level: "warn", stage: "processing_persist_deferred", taskId });
  }

  // 初始等待在 pollUpstreamTask 内进行；心跳、取消检查、轮询节奏、4xx 判定与
  // 协议解析统一由共享轮询核心处理，这里只保留本执行者特有的持久化语义
  const outcome = await pollUpstreamTask({
    taskId,
    upstreamTaskId,
    pollUrl,
    headers,
    protocol,
    pollInterval,
    maxPollAttempts,
    initialDelay,
    logChannel: "taskmgr",
    onHeartbeat: async () => {
      if (!persistPending) {
        return touchTaskHeartbeat(taskId, startedAt);
      }
      // 落盘被推迟的补投递：与心跳同周期重试（重试失败不影响主轮询）
      try {
        if (await markTaskProcessing(taskId, upstreamTaskId, startedAt)) {
          persistPending = false;
          logEvent("taskmgr", { stage: "processing_persist_recovered", taskId });
          return true;
        }
        // 守卫拒绝 = 任务已离开本次认领，同 persist 首次写入的处理
        logEvent("taskmgr", { stage: "skipped_processing_write", taskId });
        return false;
      } catch (err: unknown) {
        logWriteFailed("heartbeat", err);
        return touchTaskHeartbeat(taskId, startedAt);
      }
    },
    shouldStop: async () => {
      // Worker 停机强制收尾（drain 超时后的 abort）：轮询立即终止
      if (signal?.aborted) {
        logEvent("taskmgr", { stage: "poll_stopped", taskId, reason: "shutdown_abort" });
        return true;
      }
      // isTaskCancelled 自身吞 DB 错误视为未取消
      if (await isTaskCancelled(taskId)) {
        logEvent("taskmgr", { stage: "poll_cancelled", taskId });
        return true;
      }
      return false;
    },
  });

  switch (outcome.kind) {
    case "completed":
      logEvent("taskmgr", {
        level: "debug",
        stage: "poll_completed",
        taskId,
        urls: outcome.urls,
        text: outcome.text,
      });
      return { status: "completed", urls: outcome.urls, text: outcome.text };
    case "failed":
      return { status: "failed", urls: [], error: outcome.error, errorCode: outcome.errorCode };
    case "stopped":
      return { status: "cancelled", urls: [] };
    case "lost":
      return ownershipLost();
    case "exhausted": {
      // 预算耗尽 ≠ 上游失败：任务重置 pending 重新认领后走恢复轮询
      //（upstreamTaskId 已固化，天然不重提上游），retryCount 预算封顶。
      const requeued = await requeueProcessingAsyncTask(taskId, startedAt, cfg.WORKER_MAX_RETRIES);
      if (requeued) {
        logEvent("taskmgr", {
          stage: "poll_exhausted_requeued",
          taskId,
          upstreamTaskId,
        });
        return { status: "requeued", urls: [] };
      }
      // 预算烧完（或所有权已丢——守卫会让终态写入自然失败）才真正终态失败
      return { status: "failed", urls: [], error: outcome.error, errorCode: outcome.errorCode };
    }
  }
}
