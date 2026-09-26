/**
 * 生成任务路由。
 * 处理生成任务的创建、查询、取消与结果回传等接口。
 */
import { Hono } from "hono";
import { authenticateRequest } from "@server/http/middleware/auth";
import { taskCreateSchema } from "@server/schemas/task";
import { createTask, getTask, cancelTask, getTaskTerminalByIds, isTerminalTaskStatus, toTerminalState } from "@server/crud/task";
import type { TerminalTaskState } from "@server/services/tasks/watcher";
import { getProvider } from "@server/crud/model-config";
import { getAllowedFields, normalizeCapability, hostFromBaseUrl, resolveMatchedHost } from "@server/services/model-config";
import { taskWatcher } from "@server/services/tasks/watcher";
import { createSseResponse } from "@server/http/sse";
import { logEvent } from "@server/core/logger/utils";
import { ok, failCode } from "@server/core/response";
import { buildFileUrl } from "@server/services/storage/service";
import { localStorage } from "@server/services/storage/backends/local";
import { checkUserRateLimit } from "@server/core/ratelimit";

const router = new Hono();

/**
 * 终态回填 payload 的统一映射：SSE 快照、SSE 推送与 batch-status 对账三处共用，
 * 保证同一任务的字段形状不会随入口漂移。
 * 产物大小由服务端 stat 落盘文件直接给出（与 resultUrls 逐位对齐，缺失为 null），
 * 前端据此回填节点 data.fileSize，无需二次探测。
 */
async function toTaskPayload(state: TerminalTaskState) {
  const resultSizes = state.resultUrls
    ? await Promise.all(state.resultUrls.map(async (key) => (await localStorage.stat(key))?.size ?? null))
    : undefined;
  return {
    taskId: state.taskId,
    status: state.status,
    resultUrls: state.resultUrls?.map(buildFileUrl),
    resultSizes,
    resultText: state.resultText,
    error: state.error,
    errorCode: state.errorCode,
    prompt: state.prompt,
    config: state.config || undefined,
  };
}

router.post("/api/generate/task", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  // 按用户限流：每个任务都占用 worker 与上游配额，单用户 20 次/分钟
  if (!checkUserRateLimit("generate", auth.user.id, 20, 60)) {
    return failCode(429, "common.rate_limited");
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

  if (isTerminalTaskStatus(task.status)) {
    return failCode(400, "generate.task_already_finished");
  }

  // 守卫拒绝 = 检查与写入之间任务已终态（如恰好完成），不能谎报 cancelled
  const cancelled = await cancelTask(taskId);
  if (!cancelled) return failCode(400, "generate.task_already_finished");
  return c.json(ok(null, "cancelled"));
});

// POST /api/generate/tasks/batch-status
// 前端对账兜底：SSE 推送丢失（连接死亡 / token 过期）时，
// 页面重新可见或网络恢复时批量查询生成中任务的真实状态
router.post("/api/generate/tasks/batch-status", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: { ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === "string")
    : [];
  if (ids.length === 0) return c.json(ok([]));
  if (ids.length > 100) return failCode(422, "common.invalid_request");

  // 归属过滤下推 SQL：只查当前用户的终态行，非本人/非终态行不再拉取+反序列化后丢弃
  const tasks = await getTaskTerminalByIds(ids, { userId: auth.user.id });

  return c.json(ok(await Promise.all(tasks.map((t) => toTaskPayload(toTerminalState(t))))));
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

  // 如果已经是终态，直接返回一次性快照（走 createSseResponse 保证响应头一致）
  if (isTerminalTaskStatus(task.status)) {
    const snapshot = { type: "status", ...(await toTaskPayload(toTerminalState(task))) };
    return createSseResponse(request, async ({ emit }) => {
      emit("status", snapshot);
    });
  }

  return createSseResponse(request, async ({ emit, signal }) => {
    // watch() 只在请求中止或 watcher 被 dispose 时 resolve null，而 dispose 不中止
    // signal——不加计数的话，立即重订阅会构成零退避忙循环把 CPU 打满
    let nullResolves = 0;
    while (!signal.aborted) {
      const state = await taskWatcher.watch(taskId, signal);
      if (signal.aborted) return;
      if (!state) {
        if (++nullResolves >= 3) return;
        continue;
      }
      nullResolves = 0;

      const payload = { type: "status", ...(await toTaskPayload(state)) };
      emit("status", payload);

      // 终态：推完即关流
      if (isTerminalTaskStatus(payload.status)) return;
    }
  });
});

export { router };
