/**
 * 单任务执行器。
 * 解析任务上下文、路由到对应能力并驱动生成，更新任务状态与结果。
 */

import { routeGenerate } from "@server/services/gateway/router";
import {
  safeCompleteTask,
  safeFailTask,
  getTaskStatus,
} from "@server/crud/task";
import { getProvider } from "@server/crud/model-config";
import { resolveRefImages, resolveRefAudio, resolveRefVideo } from "@server/services/resolvers/reference";
import { resolveAndValidate } from "@server/core/ssrf";
import { getModelParams, modelFieldDefaults, hostFromBaseUrl } from "@server/services/model-config";
import {
  GenerationFailureError,
  extractFailureCode,
} from "@server/core/errors/task-failure";
import { buildContext } from "./context";
import { resumeAsyncPolling } from "./resume-polling";
import { downloadResultsWithHeartbeat } from "./download-results";
import { logEvent, classifyError } from "@server/core/logger/utils";

import type { HydratedGenerationTask } from "@server/crud/task";

/**
 * 执行单个任务的生命周期：
 * 解析 → 供应商配置 → 参考图 → AI 调用 → 结果下载落盘 → 落库 → 发事件
 *
 * 同步/异步判定由 CapabilityService 内部的 TaskManager.submitAndWait 完成，
 * Executor 不再感知异步流程（对齐 Python 架构）。
 */
export async function executeTask(task: HydratedGenerationTask): Promise<void> {
  // 已有 upstreamTaskId 说明上游受理过（典型场景：被僵尸清理重置后重新认领）。
  // 此时必须恢复轮询而不是再提交一次——否则上游会重复生成、重复计费，旧任务还会
  // 变成无人接收的孤儿。首次执行时该字段为空，照常走提交流程。
  if (task.upstreamTaskId) {
    logEvent("executor", {
      stage: "resume_poll",
      taskId: task.id,
      upstreamTaskId: task.upstreamTaskId,
      retryCount: task.retryCount,
    });
    await resumeAsyncPolling(task);
    return;
  }

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
    const resolvedImages = await resolveRefImages(ctx.refImages, task.userId);

    // 2.5 解析参考音频
    const resolvedAudio = await resolveRefAudio(ctx.refAudios, task.userId);

    // 2.6 解析参考视频
    const resolvedVideo = await resolveRefVideo(ctx.refVideos, task.userId);

    // 3. 基础参数
    const capability = task.type ?? "image";
    const protocol = task.protocol ?? provider.protocol ?? "openai";
    const model = task.model ?? (ctx.config.model as string) ?? "";

    // 4. 规范化 baseUrl（去末尾斜杠）
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");

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

    // 调用 CapabilityService（同步/异步由内部 TaskManager 自动判定）
    const result = await routeGenerate(routeCtx);

    // LLM 文本结果：直接完成，不走 URL 下载（对齐 Python _finalize_result）
    if (capability === "llm" && !result?.urls?.length && result?.text) {
      const finalized = await safeCompleteTask(task.id, {
        resultText: result.text,
      }, { startedAt: task.startedAt });
      // null = 所有权守卫拒绝或写库失败（safeCompleteTask 已记日志）；
      // 写库失败时任务停留 processing 交僵尸清理重试，不能流入 catch 误判失败
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

    // 结果落盘（对齐 Python _finalize_result + download_and_save）
    const currentStatus = await getTaskStatus(task.id);
    if (currentStatus === "cancelled") {
      logEvent("executor", { stage: "cancelled_before_download", taskId: task.id });
      return;
    }

    // 下载落盘并保持心跳（大文件下载可能远超心跳间隔，防止僵尸清理误判重跑）
    const resultUrls = await downloadResultsWithHeartbeat(
      task.id,
      task.userId,
      result?.urls ?? [],
      "Failed to download result",
      task.startedAt
    );

    // 更新任务状态（终态守卫：期间被取消的话写入会被丢弃，保留 cancelled）
    const finalized = await safeCompleteTask(task.id, {
      resultUrls,
      resultText: result?.text,
    }, { startedAt: task.startedAt });
    if (!finalized) return;

    // 全部动作（保存 + 状态更新 + 媒体处理）完成后再输出收尾节点
    const saved = resultUrls.length > 0;
    logEvent("executor", {
      banner: true,
      bannerAtEnd: true,
      bannerTitle: saved ? "生成结束，已下载并保存" : "生成结束，但无结果保存",
      stage: "completed",
      taskId: task.id,
      saved,
      urls: resultUrls,
      text: result?.text,
    });
  } catch (err: unknown) {
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

    // 所有权守卫：任务在执行期间被僵尸清理重置（pending）或重新认领（startedAt
    // 变化）时，本执行者的 failTask 会被终态守卫拒绝——重试属于新执行者，不能误杀。
    // safeFailTask 自身不抛：failTask 写库失败时记日志返回 null，不会让 DB 错误
    // 冒充生成错误上报给 loop
    await safeFailTask(task.id, {
      // 可重试标记仅体现在日志 stage 中，不再拼进展示给用户的错误文案
      error: errorMsg,
      // 失败分类落库：供前端本地化展示，也便于按错误码统计失败分布
      errorCode: code,
    }, { startedAt: task.startedAt });
  }
}
