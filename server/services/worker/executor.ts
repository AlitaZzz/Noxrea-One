/**
 * 单任务执行器。
 * 解析任务上下文、路由到对应能力并驱动生成，更新任务状态与结果。
 */

import { routeGenerate } from "@server/services/gateway/router";
import { updateTaskStatus, getTaskStatus } from "@server/crud/task";
import { getChannel } from "@server/crud/model-config";
import { downloadAndSave } from "@server/services/storage/download";
import { resolveRefImages, resolveRefAudio, resolveRefVideo } from "@server/services/resolvers/reference";
import { resolveAndValidate } from "@server/core/ssrf";
import { getModelParams, modelFieldDefaults, hostFromBaseUrl } from "@server/services/model-config";
import { buildContext } from "./context";
import { logEvent, classifyError } from "@server/core/logger/utils";

import { logger } from "@server/core/logger";
import type { HydratedGenerationTask } from "@server/crud/task";

/**
 * 执行单个任务的生命周期：
 * 解析 → 渠道配置 → 参考图 → AI 调用 → 结果下载落盘 → 落库 → 发事件
 *
 * 同步/异步判定由 CapabilityService 内部的 TaskManager.submitAndWait 完成，
 * Executor 不再感知异步流程（对齐 Python 架构）。
 */
export async function executeTask(task: HydratedGenerationTask): Promise<void> {
  const ctx = buildContext(task);

  logEvent("executor", {
    stage: "start",
    taskId: task.id,
    capability: task.type,
    protocol: task.protocol,
  });

  try {
    // 1. 获取渠道配置
    const channelId = ctx.config.channelId as number | undefined;
    if (!channelId) throw new Error("channelId not found in task config");

    const channel = await getChannel(channelId, task.userId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    // 2. 解析参考图
    const resolvedImages = await resolveRefImages(ctx.refImages, task.userId);

    // 2.5 解析参考音频
    const resolvedAudio = await resolveRefAudio(ctx.refAudios, task.userId);

    // 2.6 解析参考视频
    const resolvedVideo = await resolveRefVideo(ctx.refVideos, task.userId);

    // 3. 基础参数
    const capability = task.type ?? "image";
    const protocol = task.protocol ?? channel.protocol ?? "openai";
    const model = task.model ?? (ctx.config.model as string) ?? "";

    // 4. 规范化 baseUrl（去末尾斜杠）
    const baseUrl = channel.baseUrl.replace(/\/+$/, "");

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
      apiKey: channel.apiKey,
      model,
      channelId,
      userId: task.userId,
      taskId: task.id,
      params: rawParams,
    };

    // SSRF 校验 + DNS pinning
    try {
      const hostname = new URL(baseUrl).hostname;
      await resolveAndValidate(hostname);
    } catch (err: unknown) {
      throw new Error(`SSRF validation failed for baseUrl: ${(err as Error).message}`);
    }

    // 调用 CapabilityService（同步/异步由内部 TaskManager 自动判定）
    const result = await routeGenerate(routeCtx);

    // LLM 文本结果：直接完成，不走 URL 下载（对齐 Python _finalize_result）
    if (capability === "llm" && !result?.urls?.length && result?.text) {
      await updateTaskStatus(task.id, {
        status: "completed",
        resultText: result.text,
        completedAt: new Date(),
      });

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

    const resultUrls: string[] = [];
    for (const url of result?.urls ?? []) {
      try {
        const storageKey = await downloadAndSave(url, task.userId, task.id);
        if (storageKey) resultUrls.push(storageKey);
      } catch (err) {
        logger.error({ err, taskId: task.id }, "Failed to download result");
      }
    }

    // 更新任务状态
    await updateTaskStatus(task.id, {
      status: "completed",
      resultUrls,
      resultText: result?.text,
      completedAt: new Date(),
    });

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

    logEvent("executor", {
      stage: retryable ? "failed_retryable" : "failed",
      taskId: task.id,
      errorClass,
      error: errorMsg,
    });

    await updateTaskStatus(task.id, {
      status: "failed",
      error: errorMsg + (retryable ? " [retryable]" : ""),
      completedAt: new Date(),
    });
  }
}
