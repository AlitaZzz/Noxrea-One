// ── 单任务执行器（对应 backend/app/services/worker/executor.py） ──

import { routeGenerate } from "@server/services/gateway/router";
import { updateTaskStatus } from "@server/crud/task";
import { getChannel } from "@server/crud/model-config";
import { downloadAndSave } from "@server/services/storage/download";
import { resolveRefImages } from "@server/services/resolvers/reference";
import { resolveAndValidate } from "@server/core/ssrf";
import { getModelParams } from "@server/services/model-config";
import { buildContext } from "./context";
import { logEvent, classifyError, summarizeText } from "@server/core/logger/utils";
import { parseJsonObject } from "@server/crud/_json";
import { logger } from "@server/core/logger";
import { getConfig } from "@server/core/config";
import { prisma } from "@server/core/database/client";
import type { GenerationTask } from "@prisma/client";

/**
 * 执行单个任务的生命周期：
 * 解析 → 渠道配置 → 参考图 → AI 调用 → 结果下载落盘 → 落库 → 发事件
 *
 * 同步/异步判定由 CapabilityService 内部的 TaskManager.submitAndWait 完成，
 * Executor 不再感知异步流程（对齐 Python 架构）。
 */
export async function executeTask(task: GenerationTask): Promise<void> {
  const ctx = buildContext(task);
  const cfg = getConfig();

  logEvent("executor", {
    stage: "start",
    taskId: task.id,
    capability: task.capability,
    protocol: task.protocol,
  });

  try {
    // 1. 获取渠道配置
    const channelId = ctx.config.channel_id as number | undefined;
    if (!channelId) throw new Error("channel_id not found in task config");

    const channel = await getChannel(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    // 2. 解析参考图
    const resolvedImages = await resolveRefImages(ctx.refImages, task.userId);

    // 3. 基础参数
    const capability = task.capability ?? ctx.config.capability as string ?? "image";
    const protocol = task.protocol ?? channel.protocol ?? "openai";
    const model = task.model ?? (ctx.config.model as string) ?? "";

    // 4. 规范化 baseUrl（去末尾斜杠）
    const baseUrl = channel.baseUrl.replace(/\/+$/, "");

    // 5. 从 model_params.json 获取模型默认参数
    const modelParams = getModelParams(model, capability);
    const modelDefaults = modelParams?.defaults ?? {};

    // 6. 合并参数：默认值 < 用户传入参数
    const rawParams: Record<string, unknown> = {
      ...modelDefaults,
      prompt: task.prompt,
      ...ctx.config,
      ref_images: resolvedImages,
    };

    logEvent("executor", {
      stage: "params_merged",
      taskId: task.id,
      model,
      capability,
      protocol,
      paramsKeys: Object.keys(rawParams),
      defaults: Object.keys(modelDefaults),
    });

    // SSRF 校验 + DNS pinning
    try {
      const hostname = new URL(baseUrl).hostname;
      await resolveAndValidate(hostname);
    } catch (err: unknown) {
      throw new Error(`SSRF validation failed for base_url: ${(err as Error).message}`);
    }

    const routeCtx = {
      capability,
      protocol,
      baseUrl,
      apiKey: channel.apiKey,
      model,
      channelId,
      userId: task.userId,
      taskId: task.id,
      config: channel.config ? parseJsonObject(channel.config) : undefined,
      params: rawParams,
    };

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
        stage: "completed",
        taskId: task.id,
        textLen: result.text.length,
      });
      return;
    }

    // 结果落盘（对齐 Python _finalize_result + download_and_save）
    const currentTask = await prisma.generationTask.findUnique({ where: { id: task.id }, select: { status: true } });
    if (currentTask?.status === "cancelled") {
      logEvent("executor", { stage: "cancelled_before_download", taskId: task.id });
      return;
    }

    const resultUrls: string[] = [];
    for (const url of result?.urls ?? []) {
      try {
        const storageKey = await downloadAndSave(url, task.userId, capability, task.id);
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

    logEvent("executor", {
      stage: "completed",
      taskId: task.id,
      urls: resultUrls.length,
    });
  } catch (err: unknown) {
    const errorMsg = (err as Error)?.message ?? "Unknown error";
    const [errorClass, retryable] = classifyError(errorMsg);

    logEvent("executor", {
      stage: retryable ? "failed_retryable" : "failed",
      taskId: task.id,
      errorClass,
      error: summarizeText(errorMsg),
    });

    await updateTaskStatus(task.id, {
      status: "failed",
      error: errorMsg + (retryable ? " [retryable]" : ""),
      completedAt: new Date(),
    });
  }
}
