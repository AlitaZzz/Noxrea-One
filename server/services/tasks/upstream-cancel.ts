/**
 * 上游任务取消（best-effort）。
 * 本地取消（cancelTask 终态写入）成功后调用：若协议声明了 buildCancelRequest 能力，
 * 尽力请求上游取消，避免上游继续生成、继续计费。
 * 协议未声明取消能力或请求失败只记日志——本地取消语义永不因上游取消而失败。
 */

import { logEvent, errText } from "@server/core/logger/utils";
import { fetchWithTimeout } from "@server/core/http-client";
import { getProvider } from "@server/crud/model-config";
import { getProtocol } from "@server/services/protocols/base";
import { resolveProviderEndpoints, hostFromBaseUrl } from "@server/services/model-config";

/** 上游取消是尽力而为的旁路请求：取短超时，不让取消接口为一个旁路等待太久 */
const UPSTREAM_CANCEL_TIMEOUT_MS = 10_000;

export interface UpstreamCancelInput {
  taskId: string;
  userId: number;
  /** 上游受理过的任务 ID；为空说明上游尚未受理，无需取消 */
  upstreamTaskId?: string | null;
  /** 任务里固化的协议名（可空，回退 provider.protocol） */
  protocol?: string | null;
  capability?: string | null;
  model?: string | null;
  /** task.config.providerId；缺失/类型不符视为无法取消 */
  providerId?: unknown;
}

export async function cancelUpstreamTask(input: UpstreamCancelInput): Promise<void> {
  const { taskId, upstreamTaskId } = input;

  if (!upstreamTaskId) {
    logEvent("taskmgr", { stage: "upstream_cancel_skipped", taskId, reason: "no_upstream_task_id" });
    return;
  }
  if (typeof input.providerId !== "number") {
    logEvent("taskmgr", { stage: "upstream_cancel_skipped", taskId, reason: "no_provider_id" });
    return;
  }

  try {
    const provider = await getProvider(input.providerId, input.userId);
    if (!provider) {
      logEvent("taskmgr", { level: "warn", stage: "upstream_cancel_skipped", taskId, reason: "provider_not_found" });
      return;
    }
    const protocol = getProtocol(input.protocol ?? provider.protocol ?? "openai");
    if (!protocol?.buildCancelRequest) {
      logEvent("taskmgr", { stage: "upstream_cancel_skipped", taskId, reason: "protocol_no_cancel" });
      return;
    }

    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const endpoints = input.model
      ? resolveProviderEndpoints(hostFromBaseUrl(baseUrl), input.model, input.capability ?? "")
      : undefined;
    const channelConfig = endpoints ? { protocol: { endpoints } } : undefined;

    const req = protocol.buildCancelRequest(
      baseUrl,
      upstreamTaskId,
      provider.apiKey,
      channelConfig,
      input.capability ?? undefined
    );
    const response = await fetchWithTimeout(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      timeoutMs: UPSTREAM_CANCEL_TIMEOUT_MS,
    });
    // 消费 body 释放连接；结果只进日志，不上抛
    await response.text().catch(() => "");
    logEvent("taskmgr", {
      level: response.ok ? "info" : "warn",
      stage: response.ok ? "upstream_cancel_ok" : "upstream_cancel_failed",
      taskId,
      status: response.status,
    });
  } catch (err) {
    logEvent("taskmgr", { level: "warn", stage: "upstream_cancel_failed", taskId, error: errText(err) });
  }
}
