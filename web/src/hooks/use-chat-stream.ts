"use client";

import { useCallback, useRef, useState } from "react";

import { executeAgentTools, type AgentToolCall, type AgentToolResult } from "@/lib/agent-tools";
import { showGlobalMessage } from "@/lib/global-message";
import { getTokenHeader } from "@/lib/api";

export type ChatRole = "user" | "assistant" | "tool" | "system";

export interface ToolCallView {
  id: string;
  name: string;
  args: string;
  /** 后台下发的中文展示名（如 生成图片）；缺失时回退到 name */
  label?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** assistant 携带的工具调用（用于展示「调用工具」） */
  toolCalls?: ToolCallView[];
  /** role=tool 时对应的 tool_call_id */
  toolCallId?: string;
  /** 标记该消息为错误（如上游返回错误），用于红色样式展示 */
  error?: boolean;
}

/** 发给后端的工具调用形态（args 必须为对象，后端会 JSON.stringify 后透传上游） */
interface StreamToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  label?: string;
}

/** 发给后端的消息形态 */
interface StreamMessage {
  role: ChatRole | "tool";
  content: string;
  toolCalls?: StreamToolCall[];
  toolCallId?: string;
}

/** 把 UI 层的 args 字符串还原为对象（解析失败回退空对象，避免后端双重编码） */
function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

let _seq = 0;
function uid() {
  _seq++;
  return `m_${Date.now()}_${_seq}`;
}

/** 前端 read 空闲超时：服务端有心跳保活，但极端情况（代理重置等）下
 *  可能不触发任何事件就挂起。加 120s 超时把静默挂起变成可见报错。 */
const FRONTEND_READ_TIMEOUT_MS = 120_000;

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<{ done: boolean; value?: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new Error(`read timeout: no data for ${FRONTEND_READ_TIMEOUT_MS / 1000}s`));
    }, FRONTEND_READ_TIMEOUT_MS);
    reader.read().then(
      (r) => { clearTimeout(timer); resolve(r); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

interface RunStreamResult {
  /** done 事件是否携带 toolCalls（需要续轮） */
  hasTool: boolean;
  /** 本轮 assistant 发起的工具调用 */
  toolCalls: ToolCallView[];
  /** 本条 assistant 消息在 UI 中的 id（用于异常/续轮边界时清理占位气泡） */
  assistantId: string;
  /** 本轮累积的文本（无 tool 调用时即最终回复） */
  text: string;
}

/**
 * 高层对话封装：管理会话 + SSE 解析 + tool_call 续轮状态机。
 *
 * 续轮状态机：收到 done 且携带 toolCalls 时，调用 executeAgentTools 执行
 * （在画布建节点），把 tool 结果再次投递给 /api/chat/stream 续轮，
 * 直到无 toolCalls 才停止（最多续轮 8 轮防止死循环）。
 */
export function useChatStream(modelId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [chatTitle, setChatTitle] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);

  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);

  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  /** 移除仍在「思考中」的占位气泡（内容为空、未收到任何 delta/tool 调用） */
  const clearPendingPlaceholders = useCallback(() => {
    setMessages((prev) => prev.filter((m) => !(m.role === "assistant" && !m.content && !m.toolCalls)));
  }, []);

  /** 创建新会话（首条消息前调用），可选传入初始标题 */
  const ensureSession = useCallback(async (initialTitle?: string): Promise<string | null> => {
    if (chatId) return chatId;
    try {
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getTokenHeader() },
        body: JSON.stringify(initialTitle ? { title: initialTitle } : {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { id: string; title?: string };
      setChatId(data.id);
      if (data.title) setChatTitle(data.title);
      return data.id;
    } catch {
      showGlobalMessage().error("创建会话失败");
      return null;
    }
  }, [chatId]);

  /** 加载历史消息（切换会话时调用） */
  const loadHistory = useCallback(async (sessionId: string) => {
    try {
      const msgRes = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
        headers: { ...getTokenHeader() },
      });
      if (!msgRes.ok) throw new Error(`HTTP ${msgRes.status}`);
      const data = (await msgRes.json()) as Array<{ role: string; content: string }>;
      const loaded: ChatMessage[] = (data ?? []).map((m) => ({
        id: uid(),
        role: m.role as ChatRole,
        content: m.content,
      }));
      setMessages(loaded);
      setChatId(sessionId);
      const found = sessions.find((s) => String(s.id) === String(sessionId));
      setChatTitle(found?.title ?? null);
    } catch {
      showGlobalMessage().error("加载历史失败");
    }
  }, [sessions]);

  /** 构建发给后端的 messages（过滤 UI 内部态，仅保留可序列化角色） */
  const buildPayload = useCallback(
    (extra: StreamMessage[]): StreamMessage[] => {
      const base: StreamMessage[] = messages
        .filter((m) => m.role !== "tool" || m.toolCallId)
        .map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCalls?.length
            ? {
                toolCalls: m.toolCalls.map((t) => ({
                  id: t.id,
                  name: t.name,
                  args: parseToolArgs(t.args),
                  ...(t.label ? { label: t.label } : {}),
                })),
              }
            : {}),
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        }));
      return [...base, ...extra];
    },
    [messages]
  );

  /** 解析一段 SSE buffer 中的事件块 */
  function parseBlocks(buf: string): { blocks: Array<{ event: string; data: string }>; rest: string } {
    const raw = buf.split("\n\n");
    const rest = raw.pop() ?? "";
    const blocks = raw
      .map((block) => {
        let event = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        return { event, data };
      })
      .filter((b) => b.event && b.data);
    return { blocks, rest };
  }

  /** 发起单次流式请求，返回 done 时是否携带 toolCalls 及对应的工具调用 */
  const runStream = useCallback(
    async (
      sessionId: string,
      history: StreamMessage[],
      skills?: { name: string; title?: string }[],
      placeholderId?: string
    ): Promise<RunStreamResult> => {
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const body: Record<string, unknown> = { messages: history };
      if (skills && skills.length > 0) body.skills = skills.map((s) => s.name);

      const res = await fetch(
        `/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}&model=${encodeURIComponent(modelId)}&agent=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getTokenHeader() },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error("no stream body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let accText = "";
      let accToolCalls: ToolCallView[] = [];
      let doneHasTool = false;

      // 复用调用方预先插入的「思考中」占位气泡，保证发送后即时有反馈；
      // 若调用方未提供占位，则在此自行创建。
      const assistantId = placeholderId ?? uid();
      if (!placeholderId) appendMessage({ id: assistantId, role: "assistant", content: "" });

      const patchAssistant = (patch: Partial<ChatMessage>) => {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === assistantId);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], ...patch };
          return next;
        });
      };

      while (true) {
        const { done, value } = await readWithTimeout(reader);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { blocks, rest } = parseBlocks(buf);
        buf = rest;
        for (const { event, data } of blocks) {
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (event === "delta") {
            const delta = typeof parsed.delta === "string" ? parsed.delta : "";
            accText += delta;
            patchAssistant({ content: accText });
          } else if (event === "tool_call") {
            accToolCalls.push({
              id: parsed.id,
              name: parsed.name,
              args: typeof parsed.args === "string" ? parsed.args : JSON.stringify(parsed.args ?? {}),
              ...(parsed.label ? { label: parsed.label } : {}),
            });
          } else if (event === "done") {
            doneHasTool = Array.isArray(parsed.toolCalls) && parsed.toolCalls.length > 0;
            if (doneHasTool) {
              accToolCalls = (parsed.toolCalls ?? []).map((t: any) => ({
                id: t.id,
                name: t.name,
                args: typeof t.args === "string" ? t.args : JSON.stringify(t.args ?? {}),
                ...(t.label ? { label: t.label } : {}),
              }));
            }
          } else if (event === "error") {
            const errMsg = parsed.error || "stream error";
            patchAssistant({ content: `⚠ ${errMsg}`, error: true });
            throw new Error(errMsg);
          }
        }
      }

      if (accToolCalls.length > 0) patchAssistant({ toolCalls: accToolCalls });
      return { hasTool: doneHasTool, toolCalls: accToolCalls, assistantId, text: accText };
    },
    [appendMessage, modelId]
  );

  /** 主动停止流式 */
  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    streamingRef.current = false;
    setIsStreaming(false);
    // 清理仍停留在「思考中…」的占位气泡，避免停止后界面卡在"思考中"
    clearPendingPlaceholders();
  }, [clearPendingPlaceholders]);

  /** 发送一条用户消息并驱动整个对话（含工具续轮） */
  const sendChat = useCallback(
    async (text: string, skills?: { name: string; title?: string }[]) => {
      const trimmed = text.trim();
      if ((!trimmed && (!skills || skills.length === 0)) || streamingRef.current) return;

      // 先让用户消息出现在界面（即使后续会话创建失败也不丢失）
      const displayText = trimmed || (skills && skills.length ? skills.map((s) => s.title || s.name).join("、") : trimmed);
      appendMessage({ id: uid(), role: "user", content: displayText });

      const autoTitle = displayText.length > 24 ? `${displayText.slice(0, 24)}…` : displayText;
      const sessionId = await ensureSession(autoTitle);
      if (!sessionId) return;
      setChatTitle(autoTitle);

      streamingRef.current = true;
      setIsStreaming(true);
      setError(null);

      // 记录最近一次插入的占位气泡 id，供异常/兜底清理使用
      let lastPlaceholderId: string | null = null;

      try {
        // 用局部 history 累积所有轮次消息，避免依赖 messages state（setMessages 异步更新，
        // 循环内 buildPayload 读到的仍是旧值，会导致续轮上下文丢失、上游返回异常）。
        const history: StreamMessage[] = [{ role: "user", content: trimmed }];

        for (let round = 0; round < 8; round++) {
          // 用户已停止（stopStream 会将 streamingRef 置 false），立即终止续轮
          if (!streamingRef.current) break;

          // 先插入一条「思考中」占位气泡，保证发送后立即可见反馈
          const placeholderId = uid();
          lastPlaceholderId = placeholderId;
          appendMessage({ id: placeholderId, role: "assistant", content: "" });

          const { hasTool, toolCalls, assistantId, text } = await runStream(
            sessionId,
            history,
            skills,
            placeholderId
          );
          if (!hasTool) {
            // 续轮结束：若本轮 assistant 既无文本也无工具调用（纯空占位），
            // 删除占位气泡，避免界面残留「思考中…」
            if (!text && !toolCalls.length) {
              setMessages((prev) => prev.filter((m) => m.id !== assistantId));
            }
            break;
          }

          // 纯工具轮（无文本）会留下一条空 assistant 气泡，清理掉，避免界面出现空白消息
          if (!text) {
            setMessages((prev) => prev.filter((m) => m.id !== assistantId));
          }

          // 执行工具（在画布建节点），拿到 tool 结果
          const calls: AgentToolCall[] = toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.args },
          }));
          const results: AgentToolResult[] = executeAgentTools(calls);

          // 续轮前必须先把本轮 assistant 的 tool_calls 回填进 history，
          // 否则下一轮模型看不到「自己已经调用过工具」，会把同一意图重复调用一遍。
          // 注意 args 需还原为对象（后端会 JSON.stringify 后透传上游），且顺序必须是
          // assistant(tool_calls) 在前、tool 结果在后，否则上游会因协议非法拒绝请求。
          history.push({
            role: "assistant",
            content: text,
            toolCalls: toolCalls.map((t) => ({
              id: t.id,
              name: t.name,
              args: parseToolArgs(t.args),
              ...(t.label ? { label: t.label } : {}),
            })),
          });

          for (const r of results) {
            appendMessage({ id: uid(), role: "tool", content: r.content, toolCallId: r.tool_call_id });
            history.push({ role: "tool", content: r.content, toolCallId: r.tool_call_id });
          }
        }
      } catch (err: any) {
        if (err?.name !== "AbortError") {
          const msg = err?.message || "对话失败";
          setError(msg);
          showGlobalMessage().error(msg);
        }
      } finally {
        streamingRef.current = false;
        setIsStreaming(false);
        // 兜底：清理所有「空内容且无工具调用」的 assistant 占位气泡，
        // 避免任何异常 / 续轮边界情况下界面残留「思考中…」
        setMessages((prev) =>
          prev.filter((m) => !(m.role === "assistant" && !m.content && !m.toolCalls))
        );
      }
    },
    [appendMessage, buildPayload, ensureSession, runStream]
  );

  /** 开新对话 */
  const newChat = useCallback(() => {
    stopStream();
    setMessages([]);
    setChatId(null);
    setChatTitle(null);
    setError(null);
  }, [stopStream]);

  /** 拉取历史会话列表（按 updatedAt 倒序） */
  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/sessions", { headers: { ...getTokenHeader() } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Array<{ id: string; title: string; updatedAt: string }>;
      setSessions(data ?? []);
    } catch {
      showGlobalMessage().error("加载历史列表失败");
    }
  }, []);

  /** 删除会话；若删的是当前会话则顺带开新对话 */
  const deleteChat = useCallback(
    async (sessionId: string) => {
      try {
        const res = await fetch(`/api/chat/sessions/${sessionId}`, { method: "DELETE", headers: { ...getTokenHeader() } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (sessionId === chatId) newChat();
        showGlobalMessage().success("已删除会话");
      } catch {
        showGlobalMessage().error("删除失败");
      }
    },
    [chatId, newChat]
  );

  /** 重命名当前会话 */
  const renameChat = useCallback(async (title: string) => {
    if (!chatId) return;
    try {
      const res = await fetch(`/api/chat/sessions/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getTokenHeader() },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setChatTitle(title);
    } catch {
      showGlobalMessage().error("重命名失败");
    }
  }, [chatId]);

  return {
    messages,
    input,
    setInput,
    isStreaming,
    error,
    chatId,
    chatTitle,
    sendChat,
    stopStream,
    newChat,
    loadHistory,
    renameChat,
    sessions,
    loadSessions,
    deleteChat,
  };
}
