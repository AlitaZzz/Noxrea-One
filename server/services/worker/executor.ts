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
import { getModelParams, modelFieldDefaults } from "@server/services/model-config";
import { buildContext } from "./context";
import { logEvent, classifyError, summarizeText } from "@server/core/logger/utils";

import { logger } from "@server/core/logger";
import { getConfig } from "@server/core/config";
import type { GenerationTask } from "@prisma/client";

/**
 * 将发送参数转为日志安全形态：
 * - 疑似 base64 / 超长字符串掩码，避免泄露与日志膨胀
 * - 参考素材数组（refImages/refAudios/refVideos）只保留长度与首元素预览
 */
function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 4) return "…";
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const keys = ["refImages", "refAudios", "refVideos"];
    const first = typeof value[0] === "string" ? String(value[0]).slice(0, 64) : value[0];
    return { __len: value.length, __first: first };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.startsWith("ref") && Array.isArray(v)) {
        out[k] = sanitizeForLog(v, depth + 1);
      } else if (typeof v === "string" && isHidden(v)) {
        out[k] = `<hidden len=${v.length}>`;
      } else if (typeof v === "object" && v !== null) {
        out[k] = sanitizeForLog(v, depth + 1);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  if (typeof value === "string" && isHidden(value)) {
    return `<hidden len=${value.length}>`;
  }
  return value;
}

/** 判断字符串是否疑似 base64 数据或过长需要隐藏 */
function isHidden(s: string): boolean {
  if (s.length > 256) return true;
  // data URI / 长 base64（无空格、字符集受限、长度较长）
  if (s.length > 64 && /^[A-Za-z0-9+/=\s-]+$/.test(s) && /(?:^[A-Za-z0-9+/]{40,}={0,2}$)/.test(s.trim())) {
    return true;
  }
  return false;
}

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
    capability: task.type,
    protocol: task.protocol,
  });

  try {
    // 1. 获取渠道配置
    const channelId = ctx.config.channelId as number | undefined;
    if (!channelId) throw new Error("channelId not found in task config");

    const channel = await getChannel(channelId);
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

    // 5. 从 model-ui.json 获取模型默认参数
    const modelParams = getModelParams(model, capability);
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

    logEvent("executor", {
      stage: "params_merged",
      taskId: task.id,
      model,
      capability,
      protocol,
      paramsKeys: Object.keys(rawParams),
      defaults: Object.keys(modelDefaults),
    });

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

    // 打印真正发送给上游的参数（隐藏 base64 / 大体积值，避免泄露与日志膨胀）
    // 放在 SSRF 校验之前，确保 DNS 失败时也能看到将要发送的参数内容。
    logEvent("executor", {
      stage: "sending_request",
      taskId: task.id,
      capability,
      protocol,
      baseUrl,
      model,
      params: sanitizeForLog(routeCtx.params),
    });

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
