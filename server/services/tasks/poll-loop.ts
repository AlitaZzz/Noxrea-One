/**
 * 上游异步任务单次轮询（specs/task-queue-bullmq.md 规则 1：轮询 tick 化）。
 *
 * 每次调用执行一次「HTTP GET → 协议解析」，返回单次结果；轮询节奏（延迟 tick）、
 * 预算、取消检查与终态写入全部上移到 worker 的 tick handler——本模块只覆盖
 * 「一次轮询尝试」这一段，是提交路径与恢复路径共用的唯一轮询实现。
 */
import { fetchWithTimeout } from "@server/core/http-client";
import { logger } from "@server/core/logger";
import { logEvent, errText } from "@server/core/logger/utils";
import { extractUpstreamMessage } from "@server/services/tasks/failure";
import type { ProtocolService } from "@server/services/protocols/base";

export type PollOnceOutcome =
  | { kind: "completed"; urls: string[]; text?: string }
  | { kind: "failed"; error: string; errorCode?: string }
  /** 上游仍在生成（含非致命异常状态码），按当轮尝试计数，下一 tick 再查 */
  | { kind: "pending" }
  /** 网络类异常（超时/连接失败/响应体损坏）：同 pending 计入当轮尝试 */
  | { kind: "error"; error: string };

export interface PollOnceInput {
  taskId: string;
  upstreamTaskId: string;
  pollUrl: string;
  headers: Record<string, string>;
  protocol: ProtocolService;
  /** Worker 停机中止信号：drain 超时后中止在途轮询请求 */
  signal?: AbortSignal;
  /** 日志通道名（taskmgr / resume_poll） */
  logChannel: string;
}

export async function pollUpstreamOnce(input: PollOnceInput): Promise<PollOnceOutcome> {
  const { taskId, upstreamTaskId, pollUrl, headers, protocol, signal, logChannel } = input;

  try {
    logEvent(logChannel, { level: "debug", stage: "poll_attempt", taskId, pollUrl });
    const pollResp = await fetchWithTimeout(pollUrl, {
      headers,
      scene: "poll",
      signal,
    });
    logEvent(logChannel, { level: "debug", stage: "poll_response", taskId, status: pollResp.status });

    if (!pollResp.ok) {
      // 永久性 4xx（除 408/425/429 外）：重试无意义，直接失败。
      // 408/425/429 属瞬态，与 5xx 一致留给下一 tick（协议或限流窗口恢复后自然收敛）
      const permanent = pollResp.status >= 400 && pollResp.status < 500 &&
        ![408, 425, 429].includes(pollResp.status);
      if (permanent) {
        logger.warn({ taskId, status: pollResp.status }, "poll permanent error");
        // 4xx 响应体可能携带失败原因（如内容安全拒绝），与提交路径共用同一文案提取规则；
        // 纯文本体（网关错误页等）由提取器原样截断透传
        const errText = await pollResp.text().catch(() => "");
        const upstreamMsg = extractUpstreamMessage(errText);
        return {
          kind: "failed",
          error: upstreamMsg
            ? `${upstreamMsg}（HTTP ${pollResp.status}）`
            : `轮询失败（HTTP ${pollResp.status}），upstream_task_id=${upstreamTaskId}`,
        };
      }
      logger.warn({ taskId, status: pollResp.status }, "poll bad status");
      return { kind: "pending" };
    }

    let pollData: unknown;
    try {
      pollData = await pollResp.json();
    } catch (err: unknown) {
      logger.warn({ taskId, err: errText(err) }, "poll body parse error");
      return { kind: "error", error: errText(err) };
    }
    logEvent(logChannel, { level: "debug", stage: "poll_body", taskId, body: JSON.stringify(pollData) });

    const parsed = protocol.parsePollResponse?.(pollData)
      ?? { status: "pending" as const, urls: [] as string[] };
    logEvent(logChannel, {
      level: "debug",
      stage: "poll_parsed",
      taskId,
      status: parsed.status,
      urls: parsed.urls.length,
      error: parsed.error,
    });

    if (parsed.status === "completed") {
      return { kind: "completed", urls: parsed.urls, text: parsed.text };
    }

    if (parsed.status === "failed") {
      logEvent(logChannel, {
        stage: "poll_upstream_failed",
        taskId,
        error: parsed.error,
      });
      return { kind: "failed", error: parsed.error ?? "Upstream task failed" };
    }

    // pending: 下一 tick 再查
    return { kind: "pending" };
  } catch (err: unknown) {
    // 停机中止不按网络错误计：调用方以 signal.aborted 区分（不调度下一 tick）
    logger.warn({ taskId, err: errText(err) }, "poll error");
    return { kind: "error", error: errText(err) };
  }
}
