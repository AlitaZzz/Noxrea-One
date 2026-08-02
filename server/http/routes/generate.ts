import { Hono } from "hono";
import { authenticateRequest } from "@server/core/auth/middleware";
import { taskCreateSchema } from "@server/schemas/task";
import { createTask, getTask, cancelTask } from "@server/crud/task";
import { getChannel } from "@server/crud/model-config";
import { taskWatcher } from "@server/core/events/task-watcher";
import { logger } from "@server/core/logger";
import { ok, fail } from "@server/core/response";
import { buildFileUrl } from "@server/services/storage/service";

const router = new Hono();

// ── POST /api/generate/task ──
router.post("/api/generate/task", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  // 请求体大小限制
  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  const maxBodySize = 1024 * 1024; // 1MB
  if (contentLength > maxBodySize) {
    return fail(413, "Request body too large");
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = taskCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const data = parsed.data;

  // 模态：以 type 为准（image | video | llm | bg_removal）
  const capability = data.type ?? "image";

  // bg_removal 内部能力：不需要渠道
  let channelProtocol: string | undefined;
  if (capability !== "bg_removal") {
    if (!data.channelId) {
      return fail(400, "channelId is required");
    }
    const channel = await getChannel(data.channelId);
    if (!channel) {
      return fail(400, "Channel not found");
    }
    if (!channel.protocol) {
      return fail(400, "Channel 未配置 protocol");
    }
    channelProtocol = channel.protocol;
  }

  // config 白名单构建
  const config: Record<string, unknown> = {};
  if (data.channelId) config.channelId = data.channelId;
  if (data.model) config.model = data.model;
  if (data.protocol) config.protocol = data.protocol;

  const paramFields = new Set([
    "resolution", "ratio", "quality", "n", "strength", "seed", "background",
    "seconds", "frame_rate",
    "messages", "temperature", "max_tokens", "top_p", "stream", "stop",
    "frequency_penalty", "presence_penalty",
    "mode", "input", "voice", "audio_file",
    "references",
  ]);
  for (const [key, val] of Object.entries(body as Record<string, unknown>)) {
    if (paramFields.has(key) && val !== undefined && val !== null) {
      config[key] = val;
    }
  }

  if (data.config && typeof data.config === "object") {
    Object.assign(config, data.config as Record<string, unknown>);
  }

  if (typeof config.n === "number") {
    config.n = Math.max(1, Math.min(4, config.n as number));
  } else {
    config.n = 1;
  }

  const prompt = data.prompt ?? (config.prompt as string) ?? "";

  const task = await createTask({
    userId: auth.user.id,
    type: data.type ?? capability,
    protocol: data.protocol ?? channelProtocol ?? undefined,
    model: data.model ?? undefined,
    prompt,
    config,
    refImages: data.refImages,
    refAudio: data.refAudio,
    nodeId: data.nodeId ?? "",
  });

  return c.json(ok(task));
});

// ── GET /api/generate/task/:id ──
router.get("/api/generate/task/:id", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const taskId = c.req.param("id");
  const task = await getTask(taskId);
  if (!task) return fail(404, "Task not found");
  if (task.userId !== auth.user.id) return fail(403, "Access denied");

  return c.json(ok(task));
});

// ── POST /api/generate/task/:id/cancel ──
router.post("/api/generate/task/:id/cancel", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const taskId = c.req.param("id");

  const task = await getTask(taskId);
  if (!task) return fail(404, "Task not found");
  if (task.userId !== auth.user.id) return fail(403, "Access denied");

  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    return fail(400, "Task already finished");
  }

  await cancelTask(taskId);
  return c.json(ok(null, "cancelled"));
});

// ── GET /api/generate/task/:id/stream (SSE) ──
router.get("/api/generate/task/:id/stream", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  const taskId = c.req.param("id");

  // 校验任务存在且归属
  const task = await getTask(taskId);
  if (!task) return fail(404, "Task not found");
  if (task.userId !== auth.user.id) return fail(403, "Access denied");

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
