/**
 * 对话路由。
 * 处理聊天会话与消息的查询、创建及流式生成等接口。
 */
import { Hono } from "hono";
import { z } from "zod";
import { authenticateRequest } from "@server/core/auth/middleware";
import { fail } from "@server/core/response";
import { listSkills } from "@server/services/agent/skills/loader";
import { agentToolRegistry } from "@server/services/agent/tools/registry";
import "@server/services/agent/tools/definitions"; // 触发工具注册（副作用）
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
import { buildAgentMessages } from "@server/services/agent/context-builder";
import type { IncomingMessage, HistoryMessage } from "@server/services/agent/context-builder";
import { runCompletion, runCompletionStream } from "@server/services/agent/completion";

const router = new Hono();

// 会话 CRUD

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

// 非流式兜底：发送并落库

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
  const history: HistoryMessage[] = await listMessages(id);

  const messages = buildAgentMessages({
    history,
    incoming: [
      {
        role: "user",
        content: parsed.content,
        ...(parsed.refImages?.length ? { images: parsed.refImages } : {}),
      },
    ],
    agent: false,
  });

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

// 技能目录（供前端 / 面板使用）

router.get("/api/chat/skills", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  return c.json(listSkills());
});

// 流式对话端点

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
    messages?: IncomingMessage[];
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

  const history: HistoryMessage[] = await listMessages(sessionId);
  logEvent("chat.stream", {
    stage: "received",
    sessionId,
    model: model ?? null,
    agent,
    incoming: incoming.length,
    history: history.length,
    skills: payload.skills ?? [],
  });

  // 组装消息（分层注入：developer 身份 + developer 工具规则 + system skill）
  const messages = buildAgentMessages({
    history,
    incoming,
    skills: payload.skills,
    agent,
  });

  // 用户消息先落库（工具续轮不重复落库）
  const lastUser = incoming[incoming.length - 1];
  if (lastUser.role === "user") {
    await createMessage({
      sessionId,
      role: "user",
      content: lastUser.content,
      refImages: lastUser.images,
      skills: payload.skills && payload.skills.length ? payload.skills : undefined,
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
        skills: payload.skills,
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

      await createMessage({
        sessionId,
        role: "assistant",
        content: result.text,
        skills: payload.skills && payload.skills.length ? payload.skills : undefined,
      });
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

export { router };
