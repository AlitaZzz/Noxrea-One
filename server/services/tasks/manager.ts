/**
 * 任务管理器（specs/task-queue-bullmq.md 规则 1/3）。
 * 上游提交边界的单一入口：发送请求 → 同步结果 / 受理异步（落库 + 首 tick）/ 失败分类。
 * 异步轮询不再在进程内长驻——受理后由 BullMQ 延迟 tick 逐次驱动（见 worker/handler）。
 */

import { logEvent, errText } from "@server/core/logger/utils";
import {
  fetchUpstream,
  httpUpstreamFailure,
  noUpstreamResult,
} from "@server/services/tasks/sync-fetch";
import { acceptUpstreamTask, isTaskCancelled, takeSubmissionGate } from "@server/crud/task";
import { getSetting } from "@server/core/settings";
import { GenerationGateRejectedError } from "@server/services/tasks/failure";
import type { ProtocolService } from "@server/services/protocols/base";

export interface SubmitAndWaitResult {
  status: "completed" | "failed" | "cancelled" | "async";
  urls: string[];
  text?: string;
  error?: string;
  /**
   * 失败分类：仅在我们自己能判定原因时给出（超时 / 网络 / 上游 HTTP 等），
   * 上游自带文案的场景留空，由前端原样展示原文。
   */
  errorCode?: string;
  metadata?: Record<string, unknown>;
  /** status=async 时携带已落库的首个轮询到期时间（首 tick 延迟单源） */
  asyncNextPollAt?: Date;
}

export interface SubmitAndWaitInput {
  taskId: string;
  userId: number;
  /** 认领时间戳：acceptUpstreamTask 用它校验本执行者仍持有任务所有权 */
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
  /** Worker 停机中止信号：中止在途提交请求 */
  signal?: AbortSignal;
}

/**
 * 闸门通过后的模糊失败分类：上游接口无幂等键，请求可能已在途（计费可能已发生），
 * 这类失败绝不自动重发，以 submission_uncertain 留痕（规则 3 残余风险处置）。
 * safe-rejection 集合（拿到上游明确应答、确定未受理）沿用现行失败分类：
 * 4xx 且非 408/425（408 请求超时与 425 too early 无法排除上游已受理；429 = 明确限流拒绝）。
 * 5xx 经网关转发，无法判断源站是否已建任务 → 同样归入不确定。
 */
function isAmbiguousSubmissionFailure(status: number): boolean {
  return !(status >= 400 && status < 500 && ![408, 425].includes(status));
}

// 核心：submit_and_wait

/**
 * 同步优先异步受理：提交上游请求，同步提取结果或固化异步任务 ID。
 * 流程：
 * 1. 提交 HTTP 请求
 * 2. 尝试同步提取结果（parseResponse）→ completed
 * 3. 提取异步 task_id → 落库受理（acceptUpstreamTask + 首个 nextPollAt）→ async
 * 4. 都没有 → 失败（分类按闸门语义：明确拒绝 vs 提交不确定）
 */
export async function submitAndWait(input: SubmitAndWaitInput): Promise<SubmitAndWaitResult> {
  const { taskId, protocol, capability, channelConfig, signal } = input;

  // 1. 构建上游请求（闸门在下方 fetch 前执行）
  const req = input.buildRequest();

  // 1. 提交闸门（规则 3，唯一位置 = 上游提交点内、请求发出前）：紧贴 fetch 之前的
  //    最后一次异步边界执行条件更新——双提交被结构性排除；引用解析等前置 await 全部
  //    退到闸门前，in_flight 之后的窗口仅剩同步代码。拒绝 = 已失权或闸门已被占，
  //    抛闸门错误终止（不提交上游、不写任何终态），executor 静默收口
  const gated = await takeSubmissionGate(taskId, input.startedAt);
  if (!gated) {
    throw new GenerationGateRejectedError();
  }

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
    // 闸门已过、请求可能已在途：模糊失败不区分超时/网络细节，一律按提交不确定留痕。
    // 任务终态由 executor 写入（safeFailTask），此后绝无自动重发路径
    return {
      status: "failed",
      urls: [],
      error: outcome.error,
      errorCode: "generation.submission_uncertain",
    };
  }

  if (outcome.kind === "http-error") {
    // 错误体中可能携带 task_id：视为上游已受理，升级为异步受理
    const extractedId = protocol.extractTaskId?.(outcome.errData, channelConfig, capability);
    if (extractedId) {
      return await _acceptAsync(taskId, input.startedAt, extractedId);
    }

    // 原始响应体只进日志；对外只回传上游自带的可读文案，取不到时退化为状态码
    logEvent("taskmgr", {
      level: "warn",
      stage: "upstream_http_error",
      taskId,
      status: outcome.status,
      body: outcome.errText.slice(0, 500),
    });
    if (isAmbiguousSubmissionFailure(outcome.status)) {
      return {
        status: "failed",
        urls: [],
        error: `上游提交结果不确定（HTTP ${outcome.status}），为避免重复提交已放弃重试`,
        errorCode: "generation.submission_uncertain",
      };
    }
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

  // 3. 尝试提取异步 task_id → 异步受理
  const upstreamTaskId = protocol.extractTaskId?.(data, channelConfig, capability);
  if (upstreamTaskId) {
    logEvent("taskmgr", {
      stage: "upstream_response",
      taskId,
      body: data,
      maxLen: Infinity,
    });
    return await _acceptAsync(taskId, input.startedAt, upstreamTaskId);
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

// 内部：异步受理

/**
 * 固化上游受理（specs/task-queue-bullmq.md 规则 1）：upstreamTaskId + 首个轮询到期
 * 时间落库（acceptUpstreamTask，startedAt 令牌守卫）。落库成功后本执行段结束，
 * 轮询交给延迟 tick。守卫拒绝 = 任务已离开本次认领（取消/重置/重新认领），结果丢弃。
 */
async function _acceptAsync(
  taskId: string,
  startedAt: Date | null,
  upstreamTaskId: string
): Promise<SubmitAndWaitResult> {
  // 受理前取消检查：用户取消先于落库到达时保持 cancelled 语义（终态守卫同样兜底）
  if (await isTaskCancelled(taskId)) {
    return { status: "cancelled", urls: [] };
  }

  const firstPollAt = new Date(Date.now() + getSetting("worker.async_poll_initial_delay_seconds") * 1000);

  const logWriteFailed = (attempt: number | string, err: unknown) => {
    logEvent("taskmgr", {
      level: "warn",
      stage: "accept_write_failed",
      taskId,
      attempt,
      error: errText(err),
    });
  };

  let persisted = false;
  for (let attempt = 1; attempt <= 3 && !persisted; attempt++) {
    let threw = false;
    try {
      persisted = await acceptUpstreamTask(taskId, upstreamTaskId, startedAt, firstPollAt);
    } catch (err: unknown) {
      threw = true;
      logWriteFailed(attempt, err);
    }
    if (persisted) break;
    if (!threw) {
      // 守卫拒绝 = 任务已离开本次认领，本轮执行者已失去所有权。不能在这里写终态：
      // 重置/重认领场景下任务属于新执行者，failTask 的所有权守卫会拒绝本次写入
      logEvent("taskmgr", { stage: "skipped_accept_write", taskId });
      return {
        status: "failed",
        urls: [],
        error: "Task ownership lost",
      };
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 200 * attempt));
  }
  if (!persisted) {
    // 重试耗尽仍写不进去（DB 不可用）：本执行者无法固化 upstreamTaskId，job 结束后
    // 该 ID 随执行者消亡——行停留 processing/in_flight，租约过期后由清扫 → handler
    // 判失败 submission_uncertain（绝不重发）。宁可让用户收到失败文案，也不重复提交
    logEvent("taskmgr", { level: "error", stage: "accept_persist_failed", taskId, upstreamTaskId });
    return {
      status: "failed",
      urls: [],
      error: "生成已提交上游，但任务状态落库失败，无法继续查询进度；请稍后重试",
      errorCode: "generation.submission_uncertain",
    };
  }

  logEvent("taskmgr", {
    banner: true,
    bannerTitle: "已获取任务 ID，等待轮询",
    stage: "async_accepted",
    taskId,
    upstreamTaskId,
    firstPollAt: firstPollAt.toISOString(),
  });
  return { status: "async", urls: [], asyncNextPollAt: firstPollAt };
}
