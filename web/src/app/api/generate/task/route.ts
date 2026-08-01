import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { taskCreateSchema } from "@server/schemas/task";
import { createTask } from "@server/crud/task";
import { getChannel } from "@server/crud/model-config";
import { ok, fail } from "@server/core/response";

/**
 * 创建生成任务（对齐 backend/app/routers/generate.py create_task）
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  // 请求体大小限制：防止恶意大 JSON 导致内存耗尽
  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  const maxBodySize = 1024 * 1024; // 1MB
  if (contentLength > maxBodySize) {
    return fail(413, "Request body too large");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const parsed = taskCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(422, parsed.error.issues.map((i) => i.message).join("; "));
  }

  const data = parsed.data;

  // capability 回退：优先用 capability，其次 type
  const capability = data.capability ?? data.type ?? "image";

  // bg_removal 内部能力：不需要渠道
  if (capability !== "bg_removal") {
    if (!data.channelId) {
      return fail(400, "channelId is required");
    }
    const channel = await getChannel(data.channelId);
    if (!channel) {
      return fail(400, "Channel not found");
    }
    // protocol 检查（对齐 Python）
    if (!channel.protocol) {
      return fail(400, "Channel 未配置 protocol");
    }
  }

  // config 白名单构建（对齐 Python 精确字段控制）
  const config: Record<string, unknown> = {};
  if (data.channelId) config.channelId = data.channelId;
  if (data.model) config.model = data.model;
  if (data.protocol) config.protocol = data.protocol;

  // 从 raw body 中提取业务参数（对齐 Python _BUSINESS_PARAM_KEYS）
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

  // 用户显式传入的 config 对象合并（允许透传额外参数）
  if (data.config && typeof data.config === "object") {
    Object.assign(config, data.config as Record<string, unknown>);
  }

  // n 值钳位 1-4（对齐 Python max(1, min(4, ...))）
  if (typeof config.n === "number") {
    config.n = Math.max(1, Math.min(4, config.n as number));
  } else {
    config.n = 1;
  }

  // prompt 优先级：顶层 prompt > config.prompt
  const prompt = data.prompt ?? (config.prompt as string) ?? "";

  const task = await createTask({
    userId: auth.user.id,
    type: data.type ?? capability,
    capability,
    protocol: data.protocol ?? undefined,
    model: data.model ?? undefined,
    prompt,
    config,
    refImages: data.refImages,
    nodeId: data.nodeId ?? "",
  });

  return Response.json(ok(task));
}
