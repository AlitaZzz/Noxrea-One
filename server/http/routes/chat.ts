import { Hono } from "hono";
import { z } from "zod";
import { authenticateRequest } from "@server/core/auth/middleware";
import { fail } from "@server/core/response";
import { getChannel, getChannels } from "@server/crud/model-config";
import { getProtocol } from "@server/services/protocols/base";
import type { ProtocolToolCall } from "@server/services/protocols/base";
import { agentToolRegistry } from "@server/services/capabilities/llm/registry";
import "@server/services/capabilities/llm/tools"; // 触发工具注册（副作用）
import { listSkills, getSkill } from "@server/services/capabilities/llm/skills/loader";
import { fetchWithTimeout, getWorkerApiTimeout } from "@server/core/http-client";
import { resolveRefImages } from "@server/services/resolvers/reference";
import { logEvent } from "@server/core/logger/utils";
import {
  createSession,
  listSessions,
  getSession,
  renameSession,
  deleteSession,
  createMessage,
  listMessages,
  touchSession,
} from "@server/crud/chat";
import type { ChatRole } from "@server/crud/chat";

const router = new Hono();

// ── 会话 CRUD ──

const createChatSessionSchema = z.object({
  projectId: z.number().int().nullable().optional(),
  title: z.string().optional(),
});

router.post("/api/chat/sessions", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }
  const parsed = createChatSessionSchema.parse(body);
  const session = await createSession({
    userId,
    projectId: parsed.projectId ?? null,
    title: parsed.title,
  });
  return c.json(session, 201);
});

router.get("/api/chat/sessions", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const projectId = c.req.query("projectId");
  const pid = projectId === undefined ? undefined : Number(projectId) || null;
  const sessions = await listSessions(userId, pid);
  return c.json(sessions);
});

const renameChatSessionSchema = z.object({ title: z.string().min(1) });

router.patch("/api/chat/sessions/:id", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const id = Number(c.req.param("id"));
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }
  const parsed = renameChatSessionSchema.parse(body);
  await renameSession(id, userId, parsed.title);
  return c.json({ ok: true });
});

router.delete("/api/chat/sessions/:id", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const id = Number(c.req.param("id"));
  await deleteSession(id, userId);
  return c.json({ ok: true });
});

router.get("/api/chat/sessions/:id/messages", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const id = Number(c.req.param("id"));
  const session = await getSession(id, userId);
  if (!session) return fail(404, "session not found");
  const messages = await listMessages(id);
  return c.json(messages);
});

// ── 非流式兜底：发送并落库 ──

const sendChatMessageSchema = z.object({
  content: z.string().min(1),
  refImages: z.array(z.string()).optional(),
});

router.post("/api/chat/sessions/:id/messages", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const id = Number(c.req.param("id"));
  const session = await getSession(id, userId);
  if (!session) return fail(404, "session not found");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }
  const parsed = sendChatMessageSchema.parse(body);
  const history = await listMessages(id);

  const messages: ChatMessage[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    {
      role: "user",
      content: parsed.content,
      ...(parsed.refImages?.length ? { images: parsed.refImages } : {}),
    },
  ];

  const channelId = c.req.query("channelId");
  const model = c.req.query("model");
  const reply = await runCompletion({
    messages,
    channelId: channelId ? Number(channelId) : undefined,
    model: model ?? undefined,
    userId,
  });
  if (!reply.ok) return fail(502, reply.error);

  await createMessage({ sessionId: id, role: "user", content: parsed.content, refImages: parsed.refImages });
  const assistant = await createMessage({ sessionId: id, role: "assistant", content: reply.text });
  await touchSession(id);

  return c.json(assistant);
});

// ── 技能目录（供前端 / 面板使用） ──

router.get("/api/chat/skills", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  return c.json(listSkills());
});

// ── 流式对话端点 ──

router.post("/api/chat/stream", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const sessionId = Number(c.req.query("sessionId"));
  const channelId = c.req.query("channelId");
  const model = c.req.query("model");
  // agent=1 时注入工具定义，允许 LLM 发起 tool_call
  const agent = c.req.query("agent") === "1";

  if (!sessionId || Number.isNaN(sessionId)) return fail(400, "sessionId required");

  const session = await getSession(sessionId, userId);
  if (!session) return fail(404, "session not found");

  let payload: {
    messages?: Array<{
      role: ChatRole | "tool";
      content: string;
      images?: string[];
      toolCalls?: ProtocolToolCall[];
      toolCallId?: string;
    }>;
    /** 显式触发的技能名列表，命中后注入本轮 system 消息 */
    skills?: string[];
  };
  try {
    payload = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }
  const incoming = payload.messages ?? [];
  if (!Array.isArray(incoming) || incoming.length === 0) {
    return fail(400, "messages required");
  }

  const history = await listMessages(sessionId);
  logEvent("chat.stream", {
    stage: "received",
    sessionId,
    model: model ?? null,
    agent,
    incoming: incoming.length,
    history: history.length,
    skills: payload.skills?.length ?? 0,
  });

  // 显式触发的技能：注入一条 system 消息，必须位于整个消息序列最前
  // （OpenAI 要求 system 消息在开头；history 已含 assistant 消息时不可插在中间）
  const skillContents = (payload.skills ?? [])
    .map((name) => getSkill(name))
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map((s) => s.content);
  const skillSystem = skillContents.length
    ? [{ role: "system" as const, content: skillContents.join("\n\n---\n\n") }]
    : [];

  // Agent 行为约束：置于所有 system 之前（最前），对所有 agent 会话生效。
  // 要求模型对同一用户意图只发起一次同类工具调用，避免重复建节点。
  // 注意：不依赖 skillSystem，纯聊天进入 agent 模式时同样需要该约束。
  const agentConstraint = agent
    ? [
        {
          role: "system" as const,
          content:
            "你是 **Noxrea One Agent**，一个专注于图片、音频、视频生成与创作的智能助手。\n\n" +
            "无论是想要一段视频、一张概念图，还是一段配乐，都可以直接告诉我你的想法。我能帮你完成：\n" +
            "- 🎬 **视频生成**：给我故事、脚本或创意，我来拆分分镜、逐镜生成并最终合成成片\n" +
            "- 🖼️ **图片生成**：角色设定、场景概念图、关键帧等视觉内容\n" +
            "- 🎵 **音频生成**：配音、背景音乐、音效等声音内容\n" +
            "当用户询问你的身份或能力时，用简洁的 markdown 介绍上述信息即可。\n\n" +
            "规则：\n" +
            "1. 对于用户的每一条消息，你最多只能发起一次工具调用，绝对不要在同一轮里调用两次或以上同一工具。\n" +
            "2. 不要为同一请求生成多个变体或多个选项，一次只创建一个节点。\n" +
            "3. 每条新的用户消息都是独立的一轮，不受之前是否调用过工具的影响。" +
            "即使用户上一轮已经生成过图片，本轮只要用户提出了生成意图，就应该正常调用对应工具。",
        },
      ]
    : [];

  const messages: ChatMessage[] = [
    ...agentConstraint,
    ...skillSystem,
    ...history.map((m) => ({ role: m.role, content: m.content })),
    ...incoming.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.images?.length ? { images: m.images } : {}),
      ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    })),
  ];

  // 用户消息先落库（工具续轮不重复落库）
  const lastUser = incoming[incoming.length - 1];
  if (lastUser.role === "user") {
    await createMessage({
      sessionId,
      role: "user",
      content: lastUser.content,
      refImages: lastUser.images,
    });
    if (history.length === 0) {
      await renameSession(sessionId, userId, lastUser.content.slice(0, 30));
    }
  }

  const encoder = new TextEncoder();
  let streamClosed = false;
  // 中止上游 fetch：客户端断开后立即停止读取上游响应，释放连接
  const upstreamAbort = new AbortController();
  // 心跳定时器引用：cancel() 中需清除
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        // 已关闭则跳过，避免 ERR_INVALID_STATE: Controller is already closed
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // enqueue 失败（控制器已被关闭）时标记，后续不再写入
          streamClosed = true;
        }
      };

      // 心跳：每 15s 发送 SSE 注释行（: ping），对客户端透明，
      // 但能保持 TCP 连接活跃，防止中间代理因空闲超时断开。
      heartbeat = setInterval(() => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          streamClosed = true;
        }
      }, 15_000);

      const result = await runCompletionStream({
        messages,
        channelId: channelId ? Number(channelId) : undefined,
        model: model ?? undefined,
        userId,
        agent,
        signal: upstreamAbort.signal,
        onDelta: (delta: string) => send("delta", { delta }),
      });

      if (heartbeat) clearInterval(heartbeat);

      if (!result.ok) {
        send("error", { error: result.error });
        streamClosed = true;
        controller.close();
        return;
      }

      const toolCalls = result.toolCalls ?? [];
      if (toolCalls.length > 0) {
        logEvent("chat.stream", { stage: "tool_calls", sessionId, tools: toolCalls.map((t) => t.name).join(",") });
        // 有工具调用时不落库、不结束会话轮次，
        // 由前端执行工具后带 tool 结果再次请求续轮。
        // 给每个工具调用补上后台注册表里定义的中文展示名 label。
        const enriched = toolCalls.map((call) => ({
          ...call,
          label: agentToolRegistry.get(call.name)?.label ?? call.name,
        }));
        for (const call of enriched) {
          send("tool_call", { id: call.id, name: call.name, args: call.args, label: call.label });
        }
        send("done", { text: result.text, toolCalls: enriched });
        streamClosed = true;
        controller.close();
        return;
      }

      await createMessage({ sessionId, role: "assistant", content: result.text });
      await touchSession(sessionId);

      send("done", { text: result.text });
      streamClosed = true;
      controller.close();
    },
    cancel() {
      // 客户端断开连接（reader 取消）时由运行时调用：
      // 1. 标记关闭，避免上游残留的 onDelta 继续写入已关闭的控制器
      // 2. 中止上游 fetch，释放到火山引擎的连接
      // 3. 清除心跳定时器
      // 注意：此处不可再调用 controller.close()，否则会再次抛错。
      logEvent("chat.stream", { stage: "client_disconnect", sessionId });
      streamClosed = true;
      upstreamAbort.abort();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return c.body(stream, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
});

// ── 上游调用（复用协议层 + 参考图解析） ──

type ChatMessage = {
  role: string;
  content: string;
  images?: string[];
  /** assistant 消息携带的工具调用（用于 Agent 续轮） */
  toolCalls?: ProtocolToolCall[];
  /** role=tool 时对应的 tool_call_id */
  toolCallId?: string;
};

async function resolveChannel(channelId?: number, model?: string) {
  if (channelId) {
    const ch = await getChannel(channelId);
    if (ch) return ch;
  }
  const channels = await getChannels();
  if (model && channels.length) {
    const matched = channels.find((ch) => ch.models.some((m: { name: string }) => m.name === model));
    if (matched) return matched;
  }
  return channels[0] ?? null;
}

type BuildResult =
  | { ok: true; url: string; method: string; headers: Record<string, string>; body: unknown }
  | { ok: false; error: string };

/** 构造上游请求：解析参考图、注入 stream:true、按协议组装 body */
async function buildUpstream(args: {
  messages: ChatMessage[];
  channelId?: number;
  model?: string;
  userId: number;
  /** 是否注入 Agent 工具（仅 openai 协议支持） */
  agent?: boolean;
}): Promise<BuildResult> {
  const channel = await resolveChannel(args.channelId, args.model);
  if (!channel) return { ok: false, error: "no available channel" };

  const protocol = getProtocol(channel.protocol);
  if (!protocol?.buildLlmRequest) return { ok: false, error: `protocol ${channel.protocol} not support llm` };

  const upstreamMessages: Array<Record<string, unknown>> = [];
  for (const m of args.messages) {
    // 工具执行结果消息
    if (m.role === "tool") {
      upstreamMessages.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: m.content,
      });
      continue;
    }

    // assistant 发起的工具调用需原样回填，否则上游会拒绝后续 tool 消息
    if (m.role === "assistant" && m.toolCalls?.length) {
      upstreamMessages.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) },
        })),
      });
      continue;
    }

    if (m.images && m.images.length > 0 && channel.protocol === "openai") {
      const resolved = await resolveRefImages(m.images, args.userId);
      const content: Array<Record<string, unknown>> = [{ type: "text", text: m.content }];
      for (const url of resolved) {
        content.push({ type: "image_url", image_url: { url } });
      }
      upstreamMessages.push({ role: m.role, content });
    } else {
      upstreamMessages.push({ role: m.role, content: m.content });
    }
  }

  const body: Record<string, unknown> = {
    model: args.model ?? channel.models?.[0]?.name ?? "",
    messages: upstreamMessages,
    stream: true,
  };

  if (args.agent && channel.protocol === "openai") {
    body.tools = agentToolRegistry.getOpenAiTools();

    // 收敛策略：始终允许模型按需调用工具（auto），以便用户在同会话中再次要求生成时
    // 能真正再次建节点；仅靠 parallel_tool_calls:false 防止同一响应内并行/重复调用同类工具。
    // 历史中是否存在 tool 结果不再一刀切禁止工具调用。
    body.tool_choice = "auto";
    // 协议级约束：禁止在同一响应里并行发起多个工具调用（含重复调用同一工具），
    // 从根本上避免「同一意图生成多个重复节点」。
    body.parallel_tool_calls = false;
  }

  const req = protocol.buildLlmRequest(channel.baseUrl, channel.apiKey, body);
  return { ok: true, url: req.url, method: req.method, headers: req.headers, body: req.body };
}

type RunResult =
  | { ok: true; text: string; toolCalls?: ProtocolToolCall[] }
  | { ok: false; error: string };

async function runCompletion(args: {
  messages: ChatMessage[];
  channelId?: number;
  model?: string;
  userId: number;
}): Promise<RunResult> {
  const built = await buildUpstream(args);
  if (!built.ok) return { ok: false, error: built.error };

  try {
    const resp = await fetchWithTimeout(built.url, {
      method: built.method,
      headers: built.headers,
      body: JSON.stringify(built.body),
      scene: "async",
      timeoutMs: getWorkerApiTimeout(),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return { ok: false, error: `upstream ${resp.status}: ${txt.slice(0, 200)}` };
    }
    const data = await resp.json();
    const channel = await resolveChannel(args.channelId, args.model);
    const protocol = channel ? getProtocol(channel.protocol) : undefined;
    const text = protocol?.parseLlmResponse ? protocol.parseLlmResponse(data).text ?? "" : "";
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * 流式 body 空闲超时：fetchWithTimeout 的超时只覆盖「等响应头」阶段，
 * 响应头返回后 body 读取无任何保护——上游 200 但长时间不推数据时
 * reader.read() 会永久挂起，前端表现为一直「思考中」。
 * 这里对每次 read 加空闲超时：完全无字节到达超过阈值即主动断开，
 * 走 catch 给前端发 error 事件，把静默挂起变成可见报错。
 */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<{ done: boolean; value?: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new Error(`upstream stream idle: no data for ${STREAM_IDLE_TIMEOUT_MS / 1000}s`));
    }, STREAM_IDLE_TIMEOUT_MS);
    reader.read().then(
      (r) => { clearTimeout(timer); resolve(r); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function runCompletionStream(args: {
  messages: ChatMessage[];
  channelId?: number;
  model?: string;
  userId: number;
  agent?: boolean;
  /** 外部中止信号（客户端断开时由调用方 abort） */
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
}): Promise<RunResult> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const built = await buildUpstream(args);
  if (!built.ok) {
    logEvent("chat.stream", { stage: "build_failed", model: args.model ?? null, error: built.error });
    return { ok: false, error: built.error };
  }

  const channel = await resolveChannel(args.channelId, args.model);
  const protocolName = channel?.protocol;
  logEvent("chat.stream", {
    stage: "upstream_start",
    channel: channel?.name ?? null,
    protocol: protocolName ?? null,
    model: args.model ?? null,
    messages: args.messages.length,
    agent: args.agent ?? false,
  });

  try {
    const resp = await fetchWithTimeout(built.url, {
      method: built.method,
      headers: built.headers,
      body: JSON.stringify(built.body),
      scene: "async",
      timeoutMs: getWorkerApiTimeout(),
      ...(args.signal ? { signal: args.signal } : {}),
    });
    logEvent("chat.stream", { stage: "upstream_headers", status: resp.status, elapsedMs: elapsed() });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      logEvent("chat.stream", { stage: "upstream_error", status: resp.status, body: txt.slice(0, 200), elapsedMs: elapsed() });
      return { ok: false, error: `upstream ${resp.status}: ${txt.slice(0, 200)}` };
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let firstDeltaLogged = false;
    const toolAcc = new ToolCallAccumulator();

    while (true) {
      const { done, value } = await readWithIdleTimeout(reader);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;

        const delta = extractDelta(data, protocolName);
        if (delta) {
          if (!firstDeltaLogged) {
            firstDeltaLogged = true;
            logEvent("chat.stream", { stage: "first_delta", elapsedMs: elapsed() });
          }
          full += delta;
          args.onDelta(delta);
        }

        if (args.agent) toolAcc.feed(data);
      }
    }

    const toolCalls = toolAcc.finish();
    logEvent("chat.stream", {
      stage: "upstream_done",
      textLen: full.length,
      toolCalls: toolCalls.length,
      elapsedMs: elapsed(),
    });
    return { ok: true, text: full, ...(toolCalls.length ? { toolCalls } : {}) };
  } catch (e) {
    logEvent("chat.stream", { stage: "exception", error: String(e), elapsedMs: elapsed() });
    return { ok: false, error: String(e) };
  }
}

/**
 * 累积上游流式返回的 tool_calls 分片。
 *
 * OpenAI 流式协议里 tool_calls 是按 index 增量下发的：
 * 第一片带 id/function.name，后续片只带 function.arguments 的字符串增量。
 */
class ToolCallAccumulator {
  private slots = new Map<number, { id: string; name: string; argsText: string }>();

  feed(data: string): void {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }

    const choices = json?.choices as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(choices)) return;

    for (const choice of choices) {
      const delta = choice?.delta as Record<string, unknown> | undefined;
      const calls = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(calls)) continue;

      for (const call of calls) {
        const index = typeof call.index === "number" ? call.index : 0;
        const slot = this.slots.get(index) ?? { id: "", name: "", argsText: "" };

        if (typeof call.id === "string" && call.id) slot.id = call.id;
        const fn = call.function as Record<string, unknown> | undefined;
        if (typeof fn?.name === "string" && fn.name) slot.name = fn.name;
        if (typeof fn?.arguments === "string") slot.argsText += fn.arguments;

        this.slots.set(index, slot);
      }
    }
  }

  finish(): ProtocolToolCall[] {
    const result: ProtocolToolCall[] = [];
    for (const [index, slot] of [...this.slots.entries()].sort((a, b) => a[0] - b[0])) {
      if (!slot.name) continue;
      let parsedArgs: Record<string, unknown> = {};
      if (slot.argsText.trim()) {
        try {
          const parsed = JSON.parse(slot.argsText);
          if (parsed && typeof parsed === "object") parsedArgs = parsed as Record<string, unknown>;
        } catch {
          parsedArgs = {};
        }
      }
      result.push({
        id: slot.id || `call_${slot.name}_${index}_${Date.now()}`,
        name: slot.name,
        args: parsedArgs,
      });
    }
    return result;
  }
}

/** 从上游 SSE data 行提取增量文本，按协议分支 */
function extractDelta(data: string, protocolName?: string): string {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(data);
  } catch {
    return "";
  }

  // OpenAI / Ark(兼容) 格式
  const choices = json?.choices as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(choices)) {
    const delta = (choices[0]?.delta as Record<string, unknown> | undefined)?.content;
    if (typeof delta === "string") return delta;
  }

  // Gemini 流式格式
  const candidates = json?.candidates as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(candidates)) {
    const parts = (candidates[0]?.content as Record<string, unknown> | undefined)?.parts as
      | Array<Record<string, unknown>>
      | undefined;
    const text = parts?.[0]?.text;
    if (typeof text === "string") return text;
  }

  return "";
}

export { router };
