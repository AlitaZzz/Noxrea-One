/**
 * 画布 Agent 消息流 hook。
 * 负责发起流式请求、增量拼接回复、解析并执行工具调用、
 * 回传本轮全部工具结果并继续流式接收，直到无工具调用为止。
 * 前端不管理消息历史，后端全权负责上下文构建；
 * 画布状态快照随用户消息与工具续轮上传，模型在任何一轮看到的都是画布最新状态。
 */
"use client";

import { useCallback, useRef, useState } from "react";

import { agentApi } from "@/features/canvas/agent/api";
import { useAgentSessions } from "@/features/canvas/agent/hooks/use-agent-sessions";
import { getCanvasAgentRuntime } from "@/features/canvas/agent/Runtime";
import { serializeCanvasState } from "@/features/canvas/agent/tools/canvas-state";
import { executeCanvasToolCall } from "@/features/canvas/agent/tools/executors";
import type {
  AgentToolCall,
  ChatMessage,
  ConfirmDecision,
  PendingConfirmation,
  ToolCallView,
} from "@/features/canvas/agent/types";
import { drainUserActions } from "@/features/canvas/agent/user-action-tracker";
import { applyConfirmSelections, collectConfirmTargetNodeIds } from "@/features/canvas/agent/utils/confirm-selection";
import { takeCanvasSnapshot, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { resolveResponseError } from "@/lib/api/error-message";

/** 工具续轮上限：防止模型反复调用失败工具造成死循环 */
const MAX_TOOL_ROUNDS = 12;

/** 需要用户确认后才执行的工具（提议-确认流程）：破坏性删除类与全画布重排 */
const CONFIRM_REQUIRED_TOOLS = new Set(["delete_nodes", "delete_edges", "arrange_canvas"]);

/** 回合撤销记录：回合推送历史快照成功后登记，供末尾 section 渲染「撤销此轮」按钮 */
interface TurnUndoRecord {
  turnId: string;
  snapshot: ReturnType<typeof takeCanvasSnapshot>;
  version: number;
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
 * 会话管理委托给 useAgentSessions，本 hook 只关注消息流和工具续轮。
 */
export function useCanvasAgentStream(modelId: string, projectId?: string, providerId?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);

  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  /** 给指定 assistant 气泡补一条说明文字（已有内容则追加，无则直接写入） */
  const patchNote = useCallback((id: string, note: string) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], content: next[idx].content ? `${next[idx].content}\n\n${note}` : note };
      return next;
    });
  }, []);

  const clearPendingPlaceholders = useCallback(() => {
    setMessages((prev) => prev.filter((m) => !(m.role === "assistant" && !m.content && !m.toolCalls)));
  }, []);

  // ── 提议-确认：删除类/整理画布工具先等用户确认再执行 ──
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmation | null>(null);
  const confirmResolveRef = useRef<((decision: ConfirmDecision) => void) | null>(null);

  // ── 回合撤销：最近一次成功入栈的回合记录（末尾 section 的「撤销此轮」按钮） ──
  const [lastTurnUndo, setLastTurnUndo] = useState<TurnUndoRecord | null>(null);

  /** 用户在确认卡片上提交决定；停止对话/新对话/切会话也走此兜底（视为拒绝） */
  const respondToConfirm = useCallback((decision: ConfirmDecision) => {
    const resolve = confirmResolveRef.current;
    confirmResolveRef.current = null;
    setPendingConfirm(null);
    // 蒙层清理唯一收口：批准/取消/停止/新对话/切会话都经过这里（幂等）
    useCanvasStore.getState().clearAgentPreview();
    resolve?.(decision);
  }, []);

  /** 挂起确认卡片并等待用户决定：设置画布幻影蒙层并聚焦目标节点 */
  const requestConfirmation = useCallback((calls: AgentToolCall[]) => {
    return new Promise<ConfirmDecision>((resolve) => {
      const targetNodeIds = collectConfirmTargetNodeIds(
        calls,
        useCanvasStore.getState().nodes.map((n) => n.id)
      );
      if (targetNodeIds.length > 0) {
        useCanvasStore.getState().setAgentPreview(targetNodeIds);
        getCanvasAgentRuntime()?.focusNodes(targetNodeIds);
      }
      confirmResolveRef.current = resolve;
      setPendingConfirm({
        id: uid(),
        calls: calls.map((c) => ({ id: c.id, name: c.name, args: JSON.stringify(c.args) })),
        targetNodeIds,
      });
    });
  }, []);

  const sessions = useAgentSessions({
    onClearMessages: () => setMessages([]),
    onStopStream: () => {
      abortRef.current?.abort();
      streamingRef.current = false;
      setIsStreaming(false);
      clearPendingPlaceholders();
      respondToConfirm({ approved: false });
    },
    onLoadMessages: (loaded: ChatMessage[]) => setMessages(loaded),
    projectId,
  });

  /** 发起单次流式请求（初始消息或工具结果续轮），解析 SSE 事件 */
  const runStream = useCallback(
    async (
      res: Response,
      placeholderId?: string
    ): Promise<{ hasTool: boolean; toolCalls: ToolCallView[]; assistantId: string; text: string }> => {
      if (!res.ok) throw new Error(await resolveResponseError(res, "agent.request_failed"));
      if (!res.body) throw new Error("no stream body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let accText = "";
      let accToolCalls: ToolCallView[] = [];
      let doneHasTool = false;

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
      return { hasTool: doneHasTool, toolCalls: accToolCalls, assistantId, text: accText };
    },
    [appendMessage]
  );

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    streamingRef.current = false;
    setIsStreaming(false);
    clearPendingPlaceholders();
    respondToConfirm({ approved: false });
  }, [clearPendingPlaceholders, respondToConfirm]);

  /** 发送一条用户消息并驱动整个对话（含工具续轮） */
  const sendChat = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streamingRef.current) return;

      const turnId = uid();
      appendMessage({ id: uid(), role: "user", content: trimmed, turnId });

      // 先置 streaming，防止 ensureSession 等待期间重复发送或再次进入
      streamingRef.current = true;
      setIsStreaming(true);

      const sessionId = await sessions.ensureSession(trimmed);
      // 等待期间被 新对话 / 停止 / 切换项目 取消则直接结束
      if (!sessionId || !streamingRef.current) {
        streamingRef.current = false;
        setIsStreaming(false);
        return;
      }

      // ★ 提前创建 assistant 占位，"思考中…" 立即出现
      const placeholderId = uid();
      appendMessage({ id: placeholderId, role: "assistant", content: "", turnId });

      // 整个回合的画布变更合并为一次历史快照（agent 一批操作 = 用户一次撤销）。
      // 历史栈存「改动前」状态：首次要执行画布工具时拍快照，回合结束（含中途出错）统一入栈。
      const turn = { snapshot: null as ReturnType<typeof takeCanvasSnapshot> | null, mutated: false, pushed: false };
      const ensureTurnSnapshot = () => {
        if (!turn.snapshot) turn.snapshot = takeCanvasSnapshot();
      };
      const finishTurnHistory = () => {
        if (turn.snapshot && turn.mutated && !turn.pushed) {
          turn.pushed = true;
          useHistoryStore.getState().push(turn.snapshot);
          setLastTurnUndo({
            turnId,
            snapshot: turn.snapshot,
            version: useHistoryStore.getState().version,
          });
        }
      };

      try {
        // 初始流式请求：随消息上传画布状态快照
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        const res = await agentApi.streamAgent({
          sessionId,
          modelId,
          providerId,
          content: trimmed,
          canvasState: serializeCanvasState(),
          // 自上一条消息以来用户在画布上的操作 diff（取走即清空）
          userActions: drainUserActions(),
          signal: ctrl.signal,
        });

        let result = await runStream(res, placeholderId);

        // 工具续轮循环
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          if (!streamingRef.current) break;
          if (!result.hasTool) {
            if (!result.text && !result.toolCalls.length) {
              setMessages((prev) => prev.filter((m) => m.id !== result.assistantId));
            }
            break;
          }

          // message_user 由前端直接展示为回复文本，不进画布执行器
          const toolCalls = result.toolCalls.map((c) => {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(c.args || "{}") as Record<string, unknown>;
            } catch { /* 参数不合法时按空对象处理，执行器会给错误提示 */ }
            return { id: c.id, name: c.name, args };
          });
          const displayCalls = toolCalls.filter((c) => c.name !== "message_user");
          const messageUserCalls = toolCalls.filter((c) => c.name === "message_user");

          for (const c of messageUserCalls) {
            const text0 = typeof c.args.text === "string" ? c.args.text.trim() : "";
            if (text0) {
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === result.assistantId);
                if (idx === -1) {
                  return [...prev, { id: result.assistantId, role: "assistant" as const, content: text0 }];
                }
                const next = [...prev];
                next[idx] = { ...next[idx], content: text0 };
                return next;
              });
            }
          }

          // 执行画布工具（message_user 之外）；删除类/整理画布操作先请求用户确认（提议-确认）
          const preSnapshot = displayCalls.length > 0;
          if (preSnapshot) ensureTurnSnapshot();
          const autoCalls = displayCalls.filter((c) => !CONFIRM_REQUIRED_TOOLS.has(c.name));
          const confirmCalls = displayCalls.filter((c) => CONFIRM_REQUIRED_TOOLS.has(c.name));
          const results = autoCalls.map(executeCanvasToolCall);
          if (results.some((r) => r.mutated)) turn.mutated = true;
          if (confirmCalls.length > 0) {
            const decision = await requestConfirmation(confirmCalls);
            // 等待确认期间被 新对话/停止/切换 会话终止则不再续轮
            if (!streamingRef.current) break;
            if (decision.approved) {
              const { calls: execCalls, skipped, dropped } = applyConfirmSelections(confirmCalls, decision.selections);
              const confirmedResults = execCalls.map(executeCanvasToolCall);
              // 被勾掉的子项在结果文本里说明，供模型了解只执行了勾选部分
              for (const r of confirmedResults) {
                const n = skipped[r.toolCallId] ?? 0;
                results.push(n > 0 ? { ...r, content: `用户跳过了其中 ${n} 项，仅执行勾选部分。\n${r.content}` } : r);
              }
              for (const id of dropped) {
                results.push({ toolCallId: id, content: "用户取消了此操作的全部勾选项，未执行。", mutated: false, skipped: true });
              }
              if (confirmedResults.some((r) => r.mutated)) turn.mutated = true;
              appendMessage({
                id: uid(),
                role: "system",
                content: "",
                turnId,
                confirmResult: {
                  approved: true,
                  executedCount: confirmedResults.length,
                  skippedCount: Object.values(skipped).reduce((a, b) => a + b, 0),
                },
              });
            } else {
              for (const c of confirmCalls) {
                results.push({ toolCallId: c.id, content: "用户拒绝了此操作，未执行。", mutated: false, skipped: true });
              }
              appendMessage({
                id: uid(),
                role: "system",
                content: "",
                turnId,
                confirmResult: { approved: false, executedCount: 0, skippedCount: 0 },
              });
            }
          }
          // message_user 的结果单独回传（text 为空时如实告知模型）
          for (const c of messageUserCalls) {
            const text0 = typeof c.args.text === "string" ? c.args.text.trim() : "";
            results.push({
              toolCallId: c.id,
              content: text0 ? "消息已展示给用户。" : "text 参数为空，消息未展示。",
              mutated: false,
            });
          }
          if (results.length === 0) break;

          // 展示 tool 结果消息
          for (const r of results) {
            appendMessage({
              id: uid(),
              role: "tool",
              content: r.content,
              toolCallId: r.toolCallId,
              failed: r.failed,
              skipped: r.skipped,
              turnId,
            });
          }

          // 回传本轮全部工具结果，后端自动续轮
          const nextPlaceholderId = uid();
          appendMessage({ id: nextPlaceholderId, role: "assistant", content: "", turnId });

          const ctrl2 = new AbortController();
          abortRef.current = ctrl2;
          const res2 = await agentApi.submitToolResults({
            sessionId,
            modelId,
            providerId,
            results: results.map((r) => ({ toolCallId: r.toolCallId, result: r.content })),
            // 续轮重发最新快照：工具刚改过画布，模型必须基于执行后的状态续做
            canvasState: serializeCanvasState(),
            // 续轮等待期间用户的增量操作（对齐 tldraw：agent 多轮期间改动可见）
            userActions: drainUserActions(),
            signal: ctrl2.signal,
          });

          result = await runStream(res2, nextPlaceholderId);
        }
        // 轮数打满仍有工具调用：明确收尾，避免气泡永远挂着未执行的 chip
        if (result.hasTool) {
          patchNote(result.assistantId, "⚠ 工具调用轮数已达上限，剩余操作未执行，请重新描述需求。");
        }
        finishTurnHistory();
      } catch (err: unknown) {
        finishTurnHistory();
        const isAbort = err instanceof Error && err.name === "AbortError";
        if (!isAbort) {
          const msg = err instanceof Error ? err.message : "对话失败";
          // 错误只渲染到气泡内：patch 最后一个空的 assistant 占位
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
    [appendMessage, patchNote, sessions, runStream, modelId, providerId, requestConfirmation]
  );

  return {
    messages,
    isStreaming,
    chatId: sessions.chatId,
    chatTitle: sessions.chatTitle,
    sendChat,
    stopStream,
    newChat: sessions.newChat,
    loadHistory: sessions.loadHistory,
    renameChat: sessions.renameChat,
    sessions: sessions.sessions,
    loadSessions: sessions.loadSessions,
    deleteChat: sessions.deleteChat,
    /** 提议-确认：待用户确认的删除类工具调用 */
    pendingConfirm,
    respondToConfirm,
    /** 回合撤销：最近一次成功入栈的回合记录 */
    lastTurnUndo,
  };
}
