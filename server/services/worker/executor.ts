/**
 * 单任务执行段（提交路径，specs/task-queue-bullmq.md 规则 1/3）。
 * 仅处理无 upstreamTaskId 的任务：供应商解析 → 参考素材 → routeGenerate（提交闸门
 * 在能力层提交点内，见规则 3）→ 同步终态 / 异步受理（moveToDelayed 调度首 tick）。
 * 已有 upstreamTaskId 的任务由 handler 直接分派到轮询尝试路径，不经过本模块。
 */

import { routeGenerate } from "@server/services/gateway/router";
import {
  safeCompleteTask,
  safeFailTask,
} from "@server/crud/task";
import { getProvider } from "@server/crud/model-config";
import { resolveRefImages, resolveRefAudio, resolveRefVideo } from "@server/services/resolvers/reference";
import { resolveAndValidate } from "@server/core/ssrf";
import { stripTrailingSlash } from "@noxrea/shared/url";
import { getModelParams, modelFieldDefaults, hostFromBaseUrl } from "@server/services/model-config";
import {
  GenerationAsyncDispatchedError,
  GenerationCancelledError,
  GenerationFailureError,
  GenerationGateRejectedError,
  extractFailureCode,
} from "@server/services/tasks/failure";
import { buildContext } from "./context";
import { deferActiveTickOrThrow, type TickDeferContext } from "./queue";
import { finalizeGeneratedResult } from "./download-results";
import { logEvent, classifyError } from "@server/core/logger/utils";

import type { HydratedGenerationTask } from "@server/crud/task";

/**
 * 执行单个任务的提交生命周期：
 * 解析 → 供应商配置 → 参考图 → 提交闸门 → AI 调用 → 结果下载落盘 → 落库 → 发事件
 *
 * 同步/异步判定由 CapabilityService 内部的 TaskManager.submitAndWait 完成，
 * Executor 不再感知异步轮询流程（异步受理经 GenerationAsyncDispatchedError 返回）。
 * signal 为 per-job 中止信号：停机 drain 超时后中止在途上游请求。
 */
export async function executeSubmissionPhase(
  task: HydratedGenerationTask,
  signal: AbortSignal,
  deferCtx: TickDeferContext
): Promise<void> {
  const ctx = buildContext(task);

  logEvent("executor", {
    stage: "start",
    taskId: task.id,
    capability: task.type,
    protocol: task.protocol,
  });

  try {
    // 1. 获取供应商配置
    const providerId = ctx.config.providerId as number | undefined;
    if (!providerId) {
      throw new GenerationFailureError(
        "providerId not found in task config",
        "generation.missing_provider_id"
      );
    }

    const provider = await getProvider(providerId, task.userId);
    if (!provider) {
      throw new GenerationFailureError(
        `Provider ${providerId} not found`,
        "generation.provider_not_found"
      );
    }

    // 2. 解析参考图
    const resolvedImages = await resolveRefImages(ctx.refImages);

    // 2.5 解析参考音频
    const resolvedAudio = await resolveRefAudio(ctx.refAudios);

    // 2.6 解析参考视频
    const resolvedVideo = await resolveRefVideo(ctx.refVideos);

    // 3. 基础参数
    const capability = task.type ?? "image";
    const protocol = task.protocol ?? provider.protocol ?? "openai";
    const model = task.model ?? (ctx.config.model as string) ?? "";

    // 4. 规范化 baseUrl（去末尾斜杠）
    const baseUrl = stripTrailingSlash(provider.baseUrl);

    // 5. 从 model-ui.json 获取模型默认参数（按 host + 模型名 + 能力）
    const modelParams = getModelParams(hostFromBaseUrl(baseUrl), model, capability);
    const modelDefaults = modelFieldDefaults(modelParams);

    // 6. 合并参数：默认值 < 用户传入参数
    const rawParams: Record<string, unknown> = {
      ...modelDefaults,
      prompt: task.prompt,
      ...ctx.config,
      refImages: resolvedImages,
      ...(resolvedAudio.length > 0 ? { refAudios: resolvedAudio } : {}),
      ...(resolvedVideo.length > 0 ? { refVideos: resolvedVideo } : {}),
    };

    const routeCtx = {
      capability,
      protocol,
      baseUrl,
      apiKey: provider.apiKey,
      model,
      providerId,
      userId: task.userId,
      taskId: task.id,
      startedAt: task.startedAt,
      params: rawParams,
      signal,
    };

    // SSRF 校验 + DNS pinning
    try {
      const hostname = new URL(baseUrl).hostname;
      await resolveAndValidate(hostname);
    } catch (err: unknown) {
      throw new GenerationFailureError(
        `SSRF validation failed for baseUrl: ${(err as Error).message}`,
        "generation.ssrf_blocked"
      );
    }

    // 调用 CapabilityService（同步/异步由内部 TaskManager 自动判定；提交闸门
    // 在能力层提交点内执行，见 manager / llm service）
    const result = await routeGenerate(routeCtx);

    // LLM 文本结果：直接完成，不走 URL 下载（对齐 Python _finalize_result）
    if (capability === "llm" && !result?.urls?.length && result?.text) {
      const finalized = await safeCompleteTask(task.id, {
        resultText: result.text,
      }, { startedAt: task.startedAt });
      // null = 所有权守卫拒绝或写库失败（safeCompleteTask 已记日志）；
      // 写库失败时任务停留 processing 交清扫收口，不能流入 catch 误判失败
      if (!finalized) return;

      logEvent("executor", {
        banner: true,
        bannerAtEnd: true,
        bannerTitle: "生成结束，任务已完成",
        stage: "completed",
        taskId: task.id,
        textLen: result.text.length,
      });
      return;
    }

    // 结果终态编排单源：下载落盘（带心跳）→ 空结果判失败 → safe 终态 → 收尾日志
    // （LLM 纯文本结果在上面已提前完成，不走 URL 下载，对齐 Python _finalize_result）
    await finalizeGeneratedResult({
      taskId: task.id,
      userId: task.userId,
      startedAt: task.startedAt,
      urls: result?.urls ?? [],
      text: result?.text,
      logLabel: "Failed to download result",
      logChannel: "executor",
    });
  } catch (err: unknown) {
    // 任务已被取消（DB 中已是 cancelled 终态）：终态守卫会拒绝任何写入，
    // 直接结束本次执行，不把取消冒充为生成失败
    if (err instanceof GenerationCancelledError) {
      logEvent("executor", { stage: "cancelled", taskId: task.id });
      return;
    }
    // 提交闸门拒绝（能力层提交点抛出，规则 3）：已失权或闸门已被占——
    // 不提交上游、不写任何终态，静默收口
    if (err instanceof GenerationGateRejectedError) {
      logEvent("executor", { stage: "submission_gate_rejected", taskId: task.id });
      return;
    }
    // 上游已受理（upstreamTaskId 与首个 nextPollAt 已落库）：首 tick 原位自调度
    // （moveToDelayed，规则 2 回写——processor 内同 jobId 必为 active，重激活原语
    // 恒 skipped）后结束本次执行，不写任何终态（任务处于 processing 轮询段语义）。
    // 延迟单源：以已落库的 nextPollAt 推算，禁止再读设置重复换算。
    // 调度失败不致命：nextPollAt 已落库，tick 逾期后清扫重激活自愈
    if (err instanceof GenerationAsyncDispatchedError) {
      await deferActiveTickOrThrow(deferCtx, task.id, err.nextPollAt);
      return;
    }
    const errorMsg = (err as Error)?.message ?? "Unknown error";
    const [errorClass, retryable] = classifyError(errorMsg);
    const { code } = extractFailureCode(err);

    logEvent("executor", {
      stage: retryable ? "failed_retryable" : "failed",
      taskId: task.id,
      errorClass,
      error: errorMsg,
      errorCode: code,
    });

    // 所有权守卫：任务在执行期间被重置（pending）或重新认领（startedAt 变化）时，
    // 本执行者的 failTask 会被终态守卫拒绝——重试属于新执行者，不能误杀。
    // safeFailTask 自身不抛：failTask 写库失败时记日志返回 null，不会让 DB 错误
    // 冒充生成错误上报给 worker
    await safeFailTask(task.id, {
      // 可重试标记仅体现在日志 stage 中，不再拼进展示给用户的错误文案
      error: errorMsg,
      // 失败分类落库：供前端本地化展示，也便于按错误码统计失败分布
      errorCode: code,
    }, { startedAt: task.startedAt });
  }
}
