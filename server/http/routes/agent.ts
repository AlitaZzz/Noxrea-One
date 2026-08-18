/**
 * Agent 路由。
 * 处理 Agent 会话、技能绑定、消息流式生成与工具结果回传。
 * 技能绑定在 session 级别，前端无需每条消息携带 skills。
 */
import { Hono } from "hono";
import { z } from "zod";
import { authenticateRequest } from "@server/core/auth/middleware";
import { fail } from "@server/core/response";
import { createSseResponse } from "@server/http/sse";
import { listSkills, getSkill } from "@server/services/agent/skills/loader";
import { agentToolRegistry } from "@server/services/agent/tools/registry";
import "@server/services/agent/tools/definitions"; // 触发工具注册（副作用）
import { COMPLETE_SKILL } from "@server/services/agent/tools/definitions";
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
  setSkill,
  clearSkill,
  completeSkill,
} from "@server/crud/agent";
import { buildAgentMessages } from "@server/services/agent/context-builder";
import type { IncomingMessage, HistoryMessage } from "@server/services/agent/context-builder";
import { runCompletion, runCompletionStream } from "@server/services/agent/completion";

const router = new Hono();

// ── 会话 CRUD ──

const createSessionSchema = z.object({
  projectId: z.number().int().nullable().optional(),
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
    return fail(400, "Invalid JSON body");
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
  const pid = projectId === undefined ? undefined : Number(projectId) || null;
  const sessions = await listSessions(userId, pid);
  return c.json(sessions);
});

router.get("/api/agent/sessions/:id", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const id = Number(c.req.param("id"));
  const session = await getSession(id, userId);
  if (!session) return fail(404, "session not found");
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
    return fail(400, "Invalid JSON body");
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
  if (!session) return fail(404, "session not found");
  const messages = await listMessages(id);
  return c.json(messages);
});

// ── 技能管理 ──

const setSkillSchema = z.object({ skillName: z.string().min(1) });

router.post("/api/agent/sessions/:id/skill", async (c) => {
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
  const parsed = setSkillSchema.parse(body);
  await setSkill(id, userId, parsed.skillName);
  return c.json({ ok: true, activeSkill: parsed.skillName });
});

router.delete("/api/agent/sessions/:id/skill", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const id = Number(c.req.param("id"));
  const session = await getSession(id, userId);
  if (!session) return fail(404, "session not found");

  await clearSkill(id, userId);
  return c.json({ ok: true });
});

// ── 技能目录 ──

router.get("/api/agent/skills", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  return c.json(listSkills());
});

// ── 非流式兜底 ──

const sendMessageSchema = z.object({
  content: z.string().min(1),
  refImages: z.array(z.string()).optional(),
});

router.post("/api/agent/sessions/:id/messages", async (c) => {
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
    activeSkill: session.activeSkill,
    agent: false,
  });

  const providerId = c.req.query("providerId");
  const model = c.req.query("model");
  const reply = await runCompletion({
    messages,
    providerId: providerId ? Number(providerId) : undefined,
    model: model ?? undefined,
    userId,
  });
  if (!reply.ok) return fail(502, reply.error);

  await createMessage({ sessionId: id, role: "user", content: parsed.content, refImages: parsed.refImages });
  const assistant = await createMessage({ sessionId: id, role: "assistant", content: reply.text });
  await touchSession(id);

  return c.json(assistant);
});

// ── 流式对话端点 ──

const streamSchema = z.object({
  content: z.string().default(""),
  refImages: z.array(z.string()).optional(),
  skillName: z.string().optional(),
});

router.post("/api/agent/sessions/:id/stream", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const sessionId = Number(c.req.param("id"));
  if (!sessionId || Number.isNaN(sessionId)) return fail(400, "sessionId required");

  const session = await getSession(sessionId, userId);
  if (!session) return fail(404, "session not found");

  const providerId = c.req.query("providerId");
  const model = c.req.query("model");

  let payload: { content?: string; refImages?: string[]; skillName?: string };
  try {
    payload = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }
  const parsed = streamSchema.parse(payload);

  // 有技能激活时自动注入工具
  const agent = true;

  return createSseResponse(c.req.raw, async ({ emit, signal }) => {
      // ★ 立即 flush thinking，前端马上显示"思考中…"
      emit("thinking", {});

      // ── DB 操作移入 stream 内部，避免阻塞首个事件 ──

      // 技能绑定
      let activeSkill = session.activeSkill;
      if (parsed.skillName && parsed.skillName !== activeSkill) {
        await setSkill(sessionId, userId, parsed.skillName);
        activeSkill = parsed.skillName;
      }

      const history: HistoryMessage[] = await listMessages(sessionId);
      logEvent("agent.stream", {
        stage: "received",
        sessionId,
        model: model ?? null,
        activeSkill: activeSkill ?? null,
        skillStatus: session.skillStatus,
        history: history.length,
      });

      // 用户消息先落库
      const userContent = parsed.content || "";
      await createMessage({
        sessionId,
        role: "user",
        content: userContent,
        refImages: parsed.refImages,
      });
      if (history.length === 0) {
        // 首条消息：按内容设置标题，落库完整内容不截断
        if (userContent) {
          await renameSession(sessionId, userId, userContent);
        } else if (activeSkill) {
          // 纯技能对话：用 displayTitle 落库
          const skillMeta = getSkill(activeSkill);
          const displayTitle = skillMeta?.meta.displayTitle;
          if (displayTitle) {
            await renameSession(sessionId, userId, displayTitle);
          }
        }
      }

      // 空内容 + 有技能时，注入引导消息让 LLM 启动技能流程
      let effectiveContent = userContent;
      if (!userContent && activeSkill) {
        effectiveContent = `（用户已选择技能「${activeSkill}」，请按该技能的流程开始工作。如有需要请主动询问用户补充信息，或直接调用工具执行任务。）`;
      }

      const incoming: IncomingMessage[] = [
        {
          role: "user",
          content: effectiveContent,
          ...(parsed.refImages?.length ? { images: parsed.refImages } : {}),
        },
      ];

      // 组装消息
      const messages = buildAgentMessages({
        history,
        incoming,
        activeSkill,
        agent,
      });

      const result = await runCompletionStream({
        messages,
        providerId: providerId ? Number(providerId) : undefined,
        model: model ?? undefined,
        userId,
        agent,
        activeSkill,
        signal,
        onDelta: (delta: string) => emit("delta", { delta }),
      });


      if (!result.ok) {
        emit("error", { error: result.error });
        return;
      }

      const toolCalls = result.toolCalls ?? [];

      // 拦截 complete_skill：后端处理，不透传给前端
      const completeIdx = toolCalls.findIndex((t) => t.name === COMPLETE_SKILL);
      if (completeIdx >= 0) {
        await completeSkill(sessionId);
        emit("skill_completed", { message: "技能已完成" });

        // 无论有无文本都落库 assistant 消息，让 LLM 记住自己已结束技能
        await createMessage({ sessionId, role: "assistant", content: result.text || "" });
        await touchSession(sessionId);
        emit("done", { text: result.text, skillCompleted: true });
        return;
      }

      // 有工具调用：透传给前端执行
      if (toolCalls.length > 0) {
        logEvent("agent.stream", { stage: "tool_calls", sessionId, tools: toolCalls.map((t) => t.name).join(",") });
        const enriched = toolCalls.map((call) => {
          const def = agentToolRegistry.get(call.name);
          const validated = agentToolRegistry.validateArgs(call.name, call.args);
          if (!validated.ok) {
            logEvent("agent.tool_validation_failed", { tool: call.name, error: validated.error, args: call.args });
          }
          return {
            ...call,
            args: validated.ok ? validated.data : call.args,
            label: def?.label ?? call.name,
          };
        });
        for (const call of enriched) {
          emit("tool_call", { id: call.id, name: call.name, args: call.args, label: call.label });
        }
        // 落库 assistant 消息（含 tool_calls 的空文本）
        await createMessage({
          sessionId,
          role: "assistant",
          content: result.text || "",
        });
        emit("done", { text: result.text, toolCalls: enriched });
        return;
      }

      // 纯文本回复
      await createMessage({ sessionId, role: "assistant", content: result.text });
      await touchSession(sessionId);

      emit("done", { text: result.text });
  }, {
    onDisconnect: () => {
      logEvent("agent.stream", { stage: "client_disconnect", sessionId });
    },
  });
});

// ── 工具结果回传端点 ──

const toolResultSchema = z.object({
  toolCallId: z.string().min(1),
  result: z.string(),
});

router.post("/api/agent/sessions/:id/tool-result", async (c) => {
  const auth = await authenticateRequest(c.req.raw);
  if ("error" in auth) return auth.error;
  const userId = auth.user.id;

  const sessionId = Number(c.req.param("id"));
  if (!sessionId || Number.isNaN(sessionId)) return fail(400, "sessionId required");

  const session = await getSession(sessionId, userId);
  if (!session) return fail(404, "session not found");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }
  const parsed = toolResultSchema.parse(body);

  const providerId = c.req.query("providerId");
  const model = c.req.query("model");
  const activeSkill = session.activeSkill;
  const agent = true;

  return createSseResponse(c.req.raw, async ({ emit, signal }) => {
      // ★ 立即 flush thinking，前端马上显示"思考中…"
      emit("thinking", {});

      // ── DB 操作移入 stream 内部 ──

      // 落库 tool 消息
      await createMessage({
        sessionId,
        role: "tool",
        content: parsed.result,
        toolCallId: parsed.toolCallId,
      });

      const history: HistoryMessage[] = await listMessages(sessionId);
      const incoming: IncomingMessage[] = [
        { role: "tool", content: parsed.result, toolCallId: parsed.toolCallId },
      ];

      const messages = buildAgentMessages({
        history: history.slice(0, -1), // 排除刚落库的 tool 消息（已在 incoming 中）
        incoming,
        activeSkill,
        agent,
      });

      const result = await runCompletionStream({
        messages,
        providerId: providerId ? Number(providerId) : undefined,
        model: model ?? undefined,
        userId,
        agent,
        activeSkill,
        signal,
        onDelta: (delta: string) => emit("delta", { delta }),
      });


      if (!result.ok) {
        emit("error", { error: result.error });
        return;
      }

      const toolCalls = result.toolCalls ?? [];

      // 拦截 complete_skill
      const completeIdx = toolCalls.findIndex((t) => t.name === COMPLETE_SKILL);
      if (completeIdx >= 0) {
        await completeSkill(sessionId);
        emit("skill_completed", { message: "技能已完成" });

        // 无论有无文本都落库 assistant 消息
        await createMessage({ sessionId, role: "assistant", content: result.text || "" });
        await touchSession(sessionId);
        emit("done", { text: result.text, skillCompleted: true });
        return;
      }

      // 有工具调用：透传给前端
      if (toolCalls.length > 0) {
        logEvent("agent.stream", { stage: "tool_calls_continue", sessionId, tools: toolCalls.map((t) => t.name).join(",") });
        const enriched = toolCalls.map((call) => {
          const def = agentToolRegistry.get(call.name);
          const validated = agentToolRegistry.validateArgs(call.name, call.args);
          if (!validated.ok) {
            logEvent("agent.tool_validation_failed", { tool: call.name, error: validated.error, args: call.args });
          }
          return {
            ...call,
            args: validated.ok ? validated.data : call.args,
            label: def?.label ?? call.name,
          };
        });
        for (const call of enriched) {
          emit("tool_call", { id: call.id, name: call.name, args: call.args, label: call.label });
        }
        await createMessage({
          sessionId,
          role: "assistant",
          content: result.text || "",
        });
        emit("done", { text: result.text, toolCalls: enriched });
        return;
      }

      // 纯文本回复
      await createMessage({ sessionId, role: "assistant", content: result.text });
      await touchSession(sessionId);

      emit("done", { text: result.text });
  }, {
    onDisconnect: () => {
      logEvent("agent.stream", { stage: "client_disconnect", sessionId });
    },
  });
});

export { router };
