/**
 * Agent 消息流 hook。
 * 负责发起流式请求、增量拼接回复、解析并执行工具调用、
 * 回传工具结果并继续流式接收，直到无工具调用或技能完成。
 * 前端不再管理消息历史，后端全权负责上下文构建。
 */
"use client";

import { useCallback, useRef, useState } from "react";

import { agentApi } from "@/features/agent/api";
import { useAgentSessions } from "@/features/agent/hooks/use-agent-sessions";
import { type AgentToolCall, type AgentToolResult, executeAgentTools } from "@/features/agent/tools/agent-tools";
import type { ChatMessage, ChatRole, ToolCallView } from "@/features/agent/types";
import { findFreePosition, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { resolveResponseError } from "@/lib/api/error-message";
import { showGlobalMessage } from "@/lib/global-message";

/** 发给后端的工具调用形态（args 必须为对象，后端会 JSON.stringify 后透传上游） */
interface StreamToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  label?: string;
}

let _seq = 0;
function uid() {
  _seq++;
  return `m_${Date.now()}_${_seq}`;
}

/** 前端 read 空闲超时 */
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

/**
 * 高层对话封装：管理消息 + SSE 解析 + 工具续轮。
 *
 * 会话管理（chatId / sessions / CRUD / 技能绑定）委托给 useAgentSessions。
 * 本 hook 只关注消息流和工具续轮。
 *
 * 续轮：收到 done 且携带 toolCalls 时，调用 executeAgentTools 执行
 * （在画布建节点），把 tool 结果通过 /tool-result 端点回传后端，
 * 后端自动续轮调 LLM，直到无 toolCalls 或 skill_completed 才停止。
 */
export function useAgentStream(modelId: string, projectId?: number) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);

  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const clearPendingPlaceholders = useCallback(() => {
    setMessages((prev) => prev.filter((m) => !(m.role === "assistant" && !m.content && !m.toolCalls)));
  }, []);

  const sessions = useAgentSessions({
    onClearMessages: () => setMessages([]),
    onStopStream: () => {
      abortRef.current?.abort();
      streamingRef.current = false;
      setIsStreaming(false);
      clearPendingPlaceholders();
    },
    onLoadMessages: (loaded: ChatMessage[]) => setMessages(loaded),
    projectId,
  });

  /** 发起单次流式请求（初始消息或工具结果续轮），解析 SSE 事件 */
  const runStream = useCallback(
    async (
      res: Response,
      placeholderId?: string
    ): Promise<{ hasTool: boolean; toolCalls: ToolCallView[]; assistantId: string; text: string; skillCompleted: boolean }> => {
      if (!res.ok) throw new Error(await resolveResponseError(res, "agent.request_failed"));
      if (!res.body) throw new Error("no stream body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let accText = "";
      let accToolCalls: ToolCallView[] = [];
      let doneHasTool = false;
      let skillCompleted = false;

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
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event === "delta") {
            const delta = typeof parsed.delta === "string" ? parsed.delta : "";
            accText += delta;
            patchAssistant({ content: accText });
          } else if (event === "tool_call") {
            accToolCalls.push({
              id: typeof parsed.id === "string" ? parsed.id : "",
              name: typeof parsed.name === "string" ? parsed.name : "",
              args: typeof parsed.args === "string" ? parsed.args : JSON.stringify(parsed.args ?? {}),
              ...(typeof parsed.label === "string" ? { label: parsed.label } : {}),
            });
          } else if (event === "skill_completed") {
            skillCompleted = true;
          } else if (event === "done") {
            const toolCalls = Array.isArray(parsed.toolCalls)
              ? (parsed.toolCalls as Record<string, unknown>[])
              : [];
            doneHasTool = toolCalls.length > 0;
            if (doneHasTool) {
              accToolCalls = toolCalls.map((t) => ({
                id: typeof t.id === "string" ? t.id : "",
                name: typeof t.name === "string" ? t.name : "",
                args: typeof t.args === "string" ? t.args : JSON.stringify(t.args ?? {}),
                ...(typeof t.label === "string" ? { label: t.label } : {}),
              }));
            }
          } else if (event === "error") {
            const errMsg = typeof parsed.error === "string" ? parsed.error : "stream error";
            patchAssistant({ content: `⚠ ${errMsg}`, error: true });
            throw new Error(errMsg);
          }
        }
      }

      if (accToolCalls.length > 0) patchAssistant({ toolCalls: accToolCalls });
      return { hasTool: doneHasTool, toolCalls: accToolCalls, assistantId, text: accText, skillCompleted };
    },
    [appendMessage]
  );

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    streamingRef.current = false;
    setIsStreaming(false);
    clearPendingPlaceholders();
  }, [clearPendingPlaceholders]);

  /** 发送一条用户消息并驱动整个对话（含工具续轮） */
    const sendChat = useCallback(
      async (text: string, skillOverride?: string, skillDisplayTitle?: string) => {
      const trimmed = text.trim();
      if (streamingRef.current) return;
      const effectiveSkill = skillOverride ?? sessions.activeSkill;
      // 空文本且无技能时不发送
      if (!trimmed && !effectiveSkill) return;

      appendMessage({
        id: uid(),
        role: "user",
        content: trimmed,
        // 仅在首次选择技能发送时显示标签，后续消息不带标签
        ...(skillOverride ? { skill: skillOverride } : {}),
      });

        const autoTitle = trimmed
          ? trimmed
          : (skillDisplayTitle ?? effectiveSkill ?? "新对话");
      const sessionId = await sessions.ensureSession(autoTitle);
      if (!sessionId) return;
      sessions.setChatTitle(autoTitle);

      streamingRef.current = true;
      setIsStreaming(true);
      setError(null);

      // ★ 提前创建 assistant 占位，"思考中…" 立即出现
      const placeholderId = uid();
      appendMessage({ id: placeholderId, role: "assistant", content: "" });

      try {
        // 初始流式请求
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        const res = await agentApi.streamAgent({
          sessionId,
          modelId,
          content: trimmed,
          ...(effectiveSkill ? { skillName: effectiveSkill } : {}),
          signal: ctrl.signal,
        });

        let result = await runStream(res, placeholderId);

        // 初始流也可能直接 skill_completed（无工具调用）
        if (result.skillCompleted) {
          sessions.setActiveSkill(null);
          sessions.setSkillStatus("completed");
        }

        // 工具续轮循环
        for (let round = 0; round < 8; round++) {
          if (!streamingRef.current) break;
          if (result.skillCompleted) {
            // 后端已结束技能，同步前端状态
            sessions.setActiveSkill(null);
            sessions.setSkillStatus("completed");
            break;
          }
          if (!result.hasTool) {
            if (!result.text && !result.toolCalls.length) {
              setMessages((prev) => prev.filter((m) => m.id !== result.assistantId));
            }
            break;
          }

          // 清理空 assistant 占位
          if (!result.text) {
            setMessages((prev) => prev.filter((m) => m.id !== result.assistantId));
          }

          // 执行工具
          const calls: AgentToolCall[] = result.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.args },
          }));
          const results: AgentToolResult[] = executeAgentTools(
            calls,
            useCanvasStore.getState().addNodes,
            findFreePosition,
          );

          // 展示 tool 消息
          for (const r of results) {
            appendMessage({ id: uid(), role: "tool", content: r.content, toolCallId: r.tool_call_id });
          }

          // 回传第一个 tool 结果，后端自动续轮
          const firstResult = results[0];
          if (!firstResult) break;

          const placeholderId = uid();
          appendMessage({ id: placeholderId, role: "assistant", content: "" });

          const ctrl2 = new AbortController();
          abortRef.current = ctrl2;
          const res2 = await agentApi.submitToolResult({
            sessionId,
            modelId,
            toolCallId: firstResult.tool_call_id,
            result: firstResult.content,
            signal: ctrl2.signal,
          });

          result = await runStream(res2, placeholderId);

          // 如果有多个 tool 结果，逐个回传（非首结果不再触发新流，仅落库）
          for (let i = 1; i < results.length; i++) {
            // 后端目前只支持单 tool 续轮，多 tool 结果仅展示在 UI
            // 后续可扩展为并发续轮
          }
        }
      } catch (err: unknown) {
        const isAbort = err instanceof Error && err.name === "AbortError";
        if (!isAbort) {
          const msg = err instanceof Error ? err.message : "对话失败";
          // 错误只渲染到气泡内：patch 最后一个空的 assistant 占位
          // SSE error 事件已由 runStream 内部 patchAssistant 处理，此处兜底非 SSE 错误（HTTP 429、超时等）
          setMessages((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].role === "assistant" && !next[i].content && !next[i].toolCalls) {
                next[i] = { ...next[i], content: `⚠ ${msg}`, error: true };
                break;
              }
            }
            return next;
          });
        }
      } finally {
        streamingRef.current = false;
        setIsStreaming(false);
        setMessages((prev) =>
          prev.filter((m) => !(m.role === "assistant" && !m.content && !m.toolCalls))
        );
      }
    },
    [appendMessage, sessions, runStream, modelId]
  );

  return {
    messages,
    input,
    setInput,
    isStreaming,
    error,
    chatId: sessions.chatId,
    chatTitle: sessions.chatTitle,
    activeSkill: sessions.activeSkill,
    skillStatus: sessions.skillStatus,
    sendChat,
    stopStream,
    newChat: sessions.newChat,
    loadHistory: sessions.loadHistory,
    renameChat: sessions.renameChat,
    sessions: sessions.sessions,
    loadSessions: sessions.loadSessions,
    deleteChat: sessions.deleteChat,
    bindSkill: sessions.bindSkill,
    removeSkill: sessions.removeSkill,
  };
}
