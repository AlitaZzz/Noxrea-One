/**
 * 生成任务路由。
 * 处理生成任务的创建、查询、取消与结果回传等接口。
 */
import { Hono } from "hono";
import { authenticateRequest } from "@server/core/auth/middleware";
import { taskCreateSchema } from "@server/schemas/task";
import { createTask, getTask, cancelTask } from "@server/crud/task";
import { getProvider } from "@server/crud/model-config";
import { getAllowedFields, normalizeCapability, hostFromBaseUrl, resolveMatchedHost } from "@server/services/model-config";
import { taskWatcher } from "@server/core/events/task-watcher";
import { logger } from "@server/core/logger";
import { logEvent } from "@server/core/logger/utils";
import { ok, failCode } from "@server/core/response";
import { buildFileUrl } from "@server/services/storage/service";

const router = new Hono();

router.post("/api/generate/task", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  // 请求体大小限制
  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  const maxBodySize = 1024 * 1024; // 1MB
  if (contentLength > maxBodySize) {
    return failCode(413, "generate.body_too_large");
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const parsed = taskCreateSchema.safeParse(body);
  if (!parsed.success) {
    return failCode(422, "common.invalid_request");
  }

  const data = parsed.data;

  // 入口阶段日志：收到生成请求（对标外部服务的"收到直连参数转译请求"）
  // 原样回显前端传来的全部字段与值，便于核对请求入参
  logEvent("http.generate", {
    banner: true,
    bannerTitle: "收到生成请求",
    stage: "received",
    payload: data,
  });

  // 模态：以 type 为准，并归一化 text → llm
  const capability = normalizeCapability(data.type ?? "image");
  const model = data.model ?? "";

  if (!data.providerId) {
    return failCode(400, "generate.provider_id_required");
  }
  const provider = await getProvider(data.providerId, auth.user.id);
  if (!provider) {
    return failCode(400, "generate.provider_not_found");
  }
  if (!provider.protocol) {
    return failCode(400, "generate.provider_protocol_missing");
  }
  const providerProtocol = provider.protocol;

  const resolvedHost = resolveMatchedHost(provider.baseUrl);
  logEvent("http.generate", {
    stage: "vendor-resolve",
    providerId: provider.id,
    protocol: providerProtocol,
    baseUrl: provider.baseUrl,
    resolvedHost,
    matchedVendor: resolvedHost !== "_default",
  });
  const allowedFields = getAllowedFields(hostFromBaseUrl(provider.baseUrl), model, capability);

  // config 白名单构建：内部字段固定注入，业务字段仅放行 allowedFields 内的键
  const config: Record<string, unknown> = {};
  if (data.providerId) config.providerId = data.providerId;
  if (data.model) config.model = data.model;
  if (data.protocol) config.protocol = data.protocol;

  const allowedSet = new Set(allowedFields);
  // 参考素材字段有独立存储路径（task.refImages/refAudios/refVideos），不进 config
  const refKeys = new Set(["refImages", "refAudios", "refVideos"]);

  // 顶层业务参数：仅放行 allowedFields 内的字段，其余静默丢弃
  for (const key of Object.keys(data as Record<string, unknown>)) {
    if (!allowedSet.has(key) || refKeys.has(key)) continue;
    const val = (data as Record<string, unknown>)[key];
    if (val !== undefined && val !== null) {
      config[key] = val;
    }
  }

  // data.config 透传收紧：只放行 allowedFields 内的键，其余丢弃
  if (data.config && typeof data.config === "object") {
    const rawConfig = data.config as Record<string, unknown>;
    for (const key of Object.keys(rawConfig)) {
      if (!allowedSet.has(key) || refKeys.has(key)) continue;
      const val = rawConfig[key];
      if (val !== undefined && val !== null) {
        config[key] = val;
      }
    }
  }

  // n 仅在前端显式传入且能力声明了该字段（model-ui.json allowedFields）时收窄；
  // 默认值不在此硬编码--需要时由 model-ui.json 模型级 defaults 提供
  // （executor 的 modelDefaults 通道，合并时用户参数优先）
  if (allowedSet.has("n") && typeof config.n === "number") {
    config.n = Math.max(1, Math.min(4, config.n as number));
  }

  const prompt = data.prompt ?? (config.prompt as string) ?? "";

  const task = await createTask({
    userId: auth.user.id,
    type: capability,
    protocol: data.protocol ?? providerProtocol ?? undefined,
    model: data.model ?? undefined,
    prompt,
    config,
    refImages: data.refImages,
    refAudios: data.refAudios,
    refVideos: data.refVideos,
    nodeId: data.nodeId ?? "",
  });

  return c.json(ok(task));
});

// GET /api/generate/task/:id
router.get("/api/generate/task/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const taskId = c.req.param("id");
  const task = await getTask(taskId);
  if (!task) return failCode(404, "generate.task_not_found");
  if (task.userId !== auth.user.id) return failCode(403, "common.forbidden");

  return c.json(ok(task));
});

// POST|DELETE /api/generate/task/:id/cancel
router.on(["POST", "DELETE"], "/api/generate/task/:id/cancel", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const taskId = c.req.param("id");

  const task = await getTask(taskId);
  if (!task) return failCode(404, "generate.task_not_found");
  if (task.userId !== auth.user.id) return failCode(403, "common.forbidden");

  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    return failCode(400, "generate.task_already_finished");
  }

  await cancelTask(taskId);
  return c.json(ok(null, "cancelled"));
});

// GET /api/generate/task/:id/stream (SSE)
router.get("/api/generate/task/:id/stream", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const taskId = c.req.param("id");

  // 校验任务存在且归属
  const task = await getTask(taskId);
  if (!task) return failCode(404, "generate.task_not_found");
  if (task.userId !== auth.user.id) return failCode(403, "common.forbidden");

  // 如果已经是终态，直接返回
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    const resultUrls = (task.resultUrls as string[] | null) ?? undefined;

    const body = JSON.stringify({
      type: "status",
      taskId: task.id,
      status: task.status,
      resultUrls: resultUrls?.map(buildFileUrl),
      resultText: task.resultText,
      error: task.error,
      errorCode: task.errorCode,
      prompt: task.prompt,
      config: task.config || undefined,
    });
    return new Response(`data: ${body}\n\n`, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let aborted = false;
      let closed = false;

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch { /* already closed */ }
      };

      request.signal.addEventListener("abort", () => {
        aborted = true;
        safeClose();
      });

      // 心跳定时器
      const heartbeat = setInterval(() => {
        if (aborted || closed) return;
        safeEnqueue(encoder.encode(": ping\n\n"));
      }, 15_000);

      try {
        while (!aborted && !closed) {
          const state = await taskWatcher.watch(taskId, request.signal);
          if (aborted || closed) break;
          if (!state) continue;

          const result = { data: state };

          if (result) {
            const rawUrls: string[] | undefined = result.data.resultUrls as string[] | undefined;
            const payload = {
              type: "status",
              taskId: taskId,
              status: result.data.status,
              resultUrls: rawUrls?.map(buildFileUrl),
              resultText: result.data.resultText,
              error: result.data.error,
              errorCode: result.data.errorCode,
              prompt: result.data.prompt,
              config: result.data.config,
            };

            safeEnqueue(
              encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
            );

            if (
              payload.status === "completed" ||
              payload.status === "failed" ||
              payload.status === "cancelled"
            ) {
              break;
            }
          }
        }
      } catch (err) {
        logger.debug({ err, taskId }, "SSE stream error");
      } finally {
        clearInterval(heartbeat);
        safeClose();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

export { router };
