/**
 * Agent 路由（画布 Agent）。
 * 处理 Agent 会话、消息流式生成与工具结果回传。
 * 工具全部由前端执行：后端透传 tool_call，前端把结果回传到 /tool-result 续流。
 */
import { Hono } from "hono";
import { z } from "zod";
import { authenticateRequest } from "@server/http/middleware/auth";
import { failCode } from "@server/core/response";
import { createSseResponse } from "@server/http/sse";
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
  type PersistedToolCall,
} from "@server/crud/agent";
import { buildAgentMessages, buildCanvasSystem } from "@server/services/agent/context-builder";
import type { IncomingMessage, HistoryMessage } from "@server/services/agent/context-builder";
import { runCompletion, runCompletionStream } from "@server/services/agent/completion";

const router = new Hono();

// ── 会话 CRUD ──

const createSessionSchema = z.object({
  projectId: z.string().nullable().optional(),
  title: z.string().optional(),
});

router.post("/api/agent/sessions", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }
  const parsed = createSessionSchema.parse(body);
  const session = await createSession({
    userId,
    projectId: parsed.projectId ?? null,
    title: parsed.title,
  });
  return c.json(session, 201);
});

router.get("/api/agent/sessions", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const projectId = c.req.query("projectId");
  // projectId 现为字符串短 ID，不能再走 Number()——否则非数字 ID 会被
  // 静默转成 NaN 再回落为 null，导致会话丢失项目归属
  const pid = projectId || undefined;
  const sessions = await listSessions(userId, pid);
  return c.json(sessions);
});

router.get("/api/agent/sessions/:id", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const id = Number(c.req.param("id"));
  const session = await getSession(id, userId);
  if (!session) return failCode(404, "agent.session_not_found");
  return c.json(session);
});

const renameSchema = z.object({ title: z.string().min(1) });

router.patch("/api/agent/sessions/:id", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const id = Number(c.req.param("id"));
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }
  const parsed = renameSchema.parse(body);
  await renameSession(id, userId, parsed.title);
  return c.json({ ok: true });
});

router.delete("/api/agent/sessions/:id", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const id = Number(c.req.param("id"));
  await deleteSession(id, userId);
  return c.json({ ok: true });
});

router.get("/api/agent/sessions/:id/messages", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const id = Number(c.req.param("id"));
  const session = await getSession(id, userId);
  if (!session) return failCode(404, "agent.session_not_found");
  const messages = await listMessages(id);
  return c.json(messages);
});

// ── 非流式兜底 ──

const sendMessageSchema = z.object({
  content: z.string().min(1),
  refImages: z.array(z.string()).optional(),
  canvasState: z.unknown().optional(),
});

router.post("/api/agent/sessions/:id/messages", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const id = Number(c.req.param("id"));
  const session = await getSession(id, userId);
  if (!session) return failCode(404, "agent.session_not_found");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }
  const parsed = sendMessageSchema.parse(body);
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
    canvasSystem: buildCanvasSystem(parsed.canvasState),
  });

  const providerId = c.req.query("providerId");
  const model = c.req.query("model");
  const reply = await runCompletion({
    messages,
    providerId: providerId ? Number(providerId) : undefined,
    model: model ?? undefined,
    userId,
  });
  if (!reply.ok) {
    // 上游模型返回的原始错误只进日志，不随响应下发
    logEvent("agent.reply", { level: "warn", stage: "failed", sessionId: id, error: reply.error });
    return failCode(502, "agent.upstream_failed");
  }

  await createMessage({ sessionId: id, role: "user", content: parsed.content, refImages: parsed.refImages });
  const assistant = await createMessage({ sessionId: id, role: "assistant", content: reply.text });
  await touchSession(id);

  return c.json(assistant);
});

// ── 共享：一轮补全后的工具调用处理 ──

type TurnEmit = (event: string, data: Record<string, unknown>) => void;

/**
 * 处理一轮流式补全结果：有工具调用则校验、下发并落库；纯文本则落库收尾。
 * 返回 true 表示本轮结束（无论有无工具），false 表示上游出错已 emit error。
 */
async function finishTurn(opts: {
  sessionId: number;
  stage: string;
  text: string;
  toolCalls: PersistedToolCall[] | undefined;
  emit: TurnEmit;
}): Promise<void> {
  const { sessionId, stage, text, toolCalls, emit } = opts;
  const calls = toolCalls ?? [];

  if (calls.length > 0) {
    logEvent("agent.stream", { stage, sessionId, tools: calls.map((t) => t.name).join(",") });
    const enriched = calls.map((call) => {
      const def = agentToolRegistry.get(call.name);
      const validated = agentToolRegistry.validateArgs(call.name, call.args);
      if (!validated.ok) {
        logEvent("agent.tool_validation_failed", { tool: call.name, error: validated.error, args: call.args });
      }
      return { ...call, args: validated.ok ? validated.data : call.args, label: def?.label ?? call.name };
    });
    for (const call of enriched) {
      emit("tool_call", { id: call.id, name: call.name, args: call.args, label: call.label });
    }
    // 落库 assistant 消息（含 tool_calls，续流时需回填给上游）
    await createMessage({ sessionId, role: "assistant", content: text || "", toolCalls: enriched });
    await touchSession(sessionId);
    emit("done", { text, toolCalls: enriched });
    return;
  }

  await createMessage({ sessionId, role: "assistant", content: text });
  await touchSession(sessionId);
  emit("done", { text });
}

// ── 流式对话端点 ──

const streamSchema = z.object({
  content: z.string().default(""),
  refImages: z.array(z.string()).optional(),
  /** 前端序列化的画布状态快照（仅随用户消息发送，续流轮不重发） */
  canvasState: z.unknown().optional(),
});

router.post("/api/agent/sessions/:id/stream", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const sessionId = Number(c.req.param("id"));
  if (!sessionId || Number.isNaN(sessionId)) return failCode(400, "agent.session_id_required");

  const session = await getSession(sessionId, userId);
  if (!session) return failCode(404, "agent.session_not_found");

  const providerId = c.req.query("providerId");
  const model = c.req.query("model");

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }
  const parsed = streamSchema.parse(payload);

  return createSseResponse(c.req.raw, async ({ emit, signal }) => {
      // ★ 立即 flush thinking，前端马上显示"思考中…"
      emit("thinking", {});

      // ── DB 操作移入 stream 内部，避免阻塞首个事件 ──

      const history: HistoryMessage[] = await listMessages(sessionId);
      logEvent("agent.stream", {
        stage: "received",
        sessionId,
        model: model ?? null,
        history: history.length,
        hasCanvasState: parsed.canvasState != null,
      });

      // 用户消息先落库
      const userContent = parsed.content || "";
      await createMessage({
        sessionId,
        role: "user",
        content: userContent,
        refImages: parsed.refImages,
      });
      if (history.length === 0 && userContent) {
        // 首条消息：按内容设置标题（截断，防止长消息撑爆会话列表）
        await renameSession(sessionId, userId, userContent.slice(0, 30));
      }

      const incoming: IncomingMessage[] = [
        {
          role: "user",
          content: userContent,
          ...(parsed.refImages?.length ? { images: parsed.refImages } : {}),
        },
      ];

      const messages = buildAgentMessages({
        history,
        incoming,
        canvasSystem: buildCanvasSystem(parsed.canvasState),
      });

      const result = await runCompletionStream({
        messages,
        providerId: providerId ? Number(providerId) : undefined,
        model: model ?? undefined,
        userId,
        agent: true,
        signal,
        onDelta: (delta: string) => emit("delta", { delta }),
      });

      if (!result.ok) {
        emit("error", { error: result.error });
        return;
      }

      await finishTurn({
        sessionId,
        stage: "tool_calls",
        text: result.text,
        toolCalls: result.toolCalls,
        emit,
      });
  }, {
    onDisconnect: () => {
      logEvent("agent.stream", { stage: "client_disconnect", sessionId });
    },
  });
});

// ── 工具结果回传端点 ──

const toolResultSchema = z.object({
  /** 本轮执行的全部工具结果（通常一个，多调时不丢结果） */
  results: z.array(z.object({
    toolCallId: z.string().min(1),
    result: z.string(),
  })).min(1),
});

router.post("/api/agent/sessions/:id/tool-result", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const sessionId = Number(c.req.param("id"));
  if (!sessionId || Number.isNaN(sessionId)) return failCode(400, "agent.session_id_required");

  const session = await getSession(sessionId, userId);
  if (!session) return failCode(404, "agent.session_not_found");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return failCode(400, "common.invalid_json");
  }
  const parsed = toolResultSchema.parse(body);

  const providerId = c.req.query("providerId");
  const model = c.req.query("model");

  return createSseResponse(c.req.raw, async ({ emit, signal }) => {
      // ★ 立即 flush thinking，前端马上显示"思考中…"
      emit("thinking", {});

      // 先读历史（不含即将落库的 tool 消息），再落库 tool 消息
      const history: HistoryMessage[] = await listMessages(sessionId);
      for (const r of parsed.results) {
        await createMessage({
          sessionId,
          role: "tool",
          content: r.result,
          toolCallId: r.toolCallId,
        });
      }

      const incoming: IncomingMessage[] = parsed.results.map((r) => ({
        role: "tool",
        content: r.result,
        toolCallId: r.toolCallId,
      }));

      const messages = buildAgentMessages({ history, incoming });

      const result = await runCompletionStream({
        messages,
        providerId: providerId ? Number(providerId) : undefined,
        model: model ?? undefined,
        userId,
        agent: true,
        signal,
        onDelta: (delta: string) => emit("delta", { delta }),
      });

      if (!result.ok) {
        emit("error", { error: result.error });
        return;
      }

      await finishTurn({
        sessionId,
        stage: "tool_calls_continue",
        text: result.text,
        toolCalls: result.toolCalls,
        emit,
      });
  }, {
    onDisconnect: () => {
      logEvent("agent.stream", { stage: "client_disconnect", sessionId });
    },
  });
});

export { router };
