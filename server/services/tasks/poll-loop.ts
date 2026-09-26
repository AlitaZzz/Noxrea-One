/**
 * 上游异步任务轮询核心。
 * manager（首次提交）与 resume-polling（重启恢复）共用的唯一轮询实现：
 * 心跳推进、取消/停机检查、轮询节奏、永久性 4xx 判定与协议解析都收敛在这里，
 * 调用方只负责各自的持久化时序与终态写入语义。
 */
import { fetchWithTimeout } from "@server/core/http-client";
import { logger } from "@server/core/logger";
import { logEvent, errText } from "@server/core/logger/utils";
import { TASK_HEARTBEAT_INTERVAL_MS } from "@server/crud/task";
import { extractUpstreamMessage } from "@server/services/tasks/failure";
import type { ProtocolService } from "@server/services/protocols/base";

export type PollOutcome =
  | { kind: "completed"; urls: string[]; text?: string }
  | { kind: "failed"; error: string; errorCode?: string }
  | { kind: "stopped" }
  | { kind: "lost" };

export interface PollLoopInput {
  taskId: string;
  upstreamTaskId: string;
  pollUrl: string;
  headers: Record<string, string>;
  protocol: ProtocolService;
  pollInterval: number;
  maxPollAttempts: number;
  initialDelay: number;
  /** 心跳周期回调；返回 false = 本执行者已失去任务所有权，轮询立即终止 */
  onHeartbeat: () => Promise<boolean>;
  /** 每次轮询前的终止检查（用户取消 / Worker 停机）；true = 终止 */
  shouldStop: () => Promise<boolean>;
  /** 日志通道名（taskmgr / resume_poll） */
  logChannel: string;
}

export async function pollUpstreamTask(input: PollLoopInput): Promise<PollOutcome> {
  const {
    taskId, upstreamTaskId, pollUrl, headers, protocol,
    pollInterval, maxPollAttempts, initialDelay, onHeartbeat, shouldStop, logChannel,
  } = input;

  // 初始等待：提交后上游尚未开始处理，立即轮询无意义
  if (initialDelay > 0) {
    await new Promise((r) => setTimeout(r, initialDelay * 1000));
  }

  let lastPollData: unknown;
  let lastHeartbeatAt = Date.now();

  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    // 心跳：僵尸清理以 updatedAt 判定任务卡死，视频生成的轮询常持续十几分钟。
    // 不持续推进 updatedAt，长任务就会被误判为僵尸、重置重跑并再次提交到上游，
    // 造成重复生成与重复计费
    if (Date.now() - lastHeartbeatAt >= TASK_HEARTBEAT_INTERVAL_MS) {
      lastHeartbeatAt = Date.now();
      if (!(await onHeartbeat())) return { kind: "lost" };
    }

    // 取消 / 停机检查
    if (await shouldStop()) {
      logEvent(logChannel, { stage: "poll_stopped", taskId, attempt: attempt + 1 });
      return { kind: "stopped" };
    }

    // 第一次不延迟，后续按 pollInterval 间隔
    if (attempt > 0) {
      const delay = attempt >= 60 ? pollInterval * 2 : pollInterval;
      await new Promise((r) => setTimeout(r, delay * 1000));
    }

    try {
      logEvent(logChannel, { level: "debug", stage: "poll_attempt", taskId, attempt: attempt + 1, pollUrl });
      const pollResp = await fetchWithTimeout(pollUrl, {
        headers,
        scene: "poll",
      });
      logEvent(logChannel, { level: "debug", stage: "poll_response", taskId, attempt: attempt + 1, status: pollResp.status });

      if (!pollResp.ok) {
        // 永久性 4xx（除 408/425/429 外）：重试无意义，直接失败
        const permanent = pollResp.status >= 400 && pollResp.status < 500 &&
          ![408, 425, 429].includes(pollResp.status);
        if (permanent) {
          logger.warn({ taskId, attempt: attempt + 1, status: pollResp.status }, "poll permanent error");
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
        logger.warn({ taskId, attempt: attempt + 1, status: pollResp.status }, "poll bad status");
        continue;
      }

      const pollData = await pollResp.json();
      logEvent(logChannel, { level: "debug", stage: "poll_body", taskId, attempt: attempt + 1, body: JSON.stringify(pollData) });
      lastPollData = pollData;

      const parsed = protocol.parsePollResponse?.(pollData)
        ?? { status: "pending" as const, urls: [] as string[] };
      logEvent(logChannel, {
        level: "debug",
        stage: "poll_parsed",
        taskId,
        attempt: attempt + 1,
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
          attempt: attempt + 1,
          error: parsed.error,
        });
        return { kind: "failed", error: parsed.error ?? "Upstream task failed" };
      }

      // pending: continue
    } catch (err: unknown) {
      logger.warn({ taskId, attempt: attempt + 1, err: errText(err) }, "poll error");
    }
  }

  // 超时：上游可能仍在生成，专门错误码供前端提示
  const lastInfo = lastPollData ? ` - 上游最后返回: ${JSON.stringify(lastPollData)}` : "";
  return {
    kind: "failed",
    error: `异步轮询超时（upstream_task_id=${upstreamTaskId}）${lastInfo}`,
    errorCode: "generation.poll_timeout",
  };
}
