/**
 * Agent 会话管理 hook：会话列表加载与新建 / 切换 / 重命名 / 删除。
 * 与消息流 hook 分离，消息状态通过回调注入以避免双向耦合。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentSessionDto } from "@/features/canvas/agent/api";
import { agentApi } from "@/features/canvas/agent/api";
import type { ChatMessage, ChatRole } from "@/features/canvas/agent/types";
import { clearUserActions } from "@/features/canvas/agent/user-action-tracker";
import { ApiError } from "@/lib/api/client";
import { showGlobalMessage } from "@/lib/global-message";

let _seq = 0;
function uid() {
  _seq++;
  return `m_${Date.now()}_${_seq}`;
}

/** 失败提示优先展示服务端本地化错误（ApiError），无结构化信息时回退固定文案 */
function agentError(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

/**
 * 会话管理层：管理 chatId / chatTitle / sessions 列表 + CRUD 操作。
 * 消息状态的清空 / 加载由回调注入，避免双向耦合。
 */
export function useAgentSessions(opts: {
  /** 清空消息列表（newChat 时调用） */
  onClearMessages: () => void;
  /** 停止正在进行的流式请求（newChat / deleteChat 时调用） */
  onStopStream: () => void;
  /** 加载历史消息到 UI（切换会话时调用） */
  onLoadMessages: (messages: ChatMessage[]) => void;
  /** 当前项目 ID，切换项目时自动重置对话 */
  projectId?: string;
}) {
  const [chatId, setChatId] = useState<number | null>(null);
  const [chatTitle, setChatTitle] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSessionDto[]>([]);
  // chatId 的同步镜像：ensureSession 异步等待期间可能被 newChat / 项目切换重置，
  // ref 用于在 await 之后判断当前会话是否仍然有效
  const chatIdRef = useRef<number | null>(null);

  // 切换项目时自动重置对话，避免旧项目的会话串到新项目。
  // state 重置用渲染期条件调整（React 官方推荐的 prop 变化重置模式），
  // 避免 effect 内同步 setState 触发级联渲染；ref 清理与停流/清消息副作用仍走 effect。
  const [prevProjectId, setPrevProjectId] = useState(opts.projectId);
  if (prevProjectId !== opts.projectId) {
    setPrevProjectId(opts.projectId);
    setChatId(null);
    setChatTitle(null);
  }

  useEffect(() => {
    chatIdRef.current = null;
    clearUserActions();
    opts.onStopStream();
    opts.onClearMessages();
  }, [opts.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 创建新会话（首条消息前调用），可选传入初始标题 */
  const ensureSession = useCallback(
    async (initialTitle?: string): Promise<number | null> => {
      if (chatIdRef.current) return chatIdRef.current;
      try {
        const session = await agentApi.createSession(initialTitle, opts.projectId);
        // 等待期间被 newChat / 项目切换重置则放弃该会话，避免串到旧对话
        if (chatIdRef.current) return chatIdRef.current;
        chatIdRef.current = session.id;
        setChatId(session.id);
        if (session.title) setChatTitle(session.title);
        return session.id;
      } catch (e) {
        showGlobalMessage().error(agentError(e, "创建会话失败"));
        return null;
      }
    },
    [opts.projectId]
  );

  /** 加载历史消息（切换会话时调用） */
  const loadHistory = useCallback(
    async (sessionId: number) => {
      // 先停掉当前会话的流式回合，避免回复继续追加进即将加载的另一份消息列表
      opts.onStopStream();
      // 切会话后旧会话期间积累的用户操作不应带进新会话
      clearUserActions();
      try {
        const data = await agentApi.getSessionMessages(sessionId);
        // ghost 清理：message_user 的回执行与"内容为空且无可见工具调用"的 assistant 消息
        // （历史遗留的空占位，渲染时会永远显示"思考中…"）不进入 UI
        const messageUserCallIds = new Set(
          (data ?? []).flatMap((m) => (m.toolCalls ?? []).filter((t) => t.name === "message_user").map((t) => t.id)),
        );
        const loaded: ChatMessage[] = (data ?? []).flatMap((m) => {
          if (m.role === "tool" && m.toolCallId && messageUserCallIds.has(m.toolCallId)) return [];
          // message_user 的回执行与纯 message_user 调用不进入 UI（回复文本已在 assistant content 里）
          const visibleToolCalls = (m.toolCalls ?? []).filter((t) => t.name !== "message_user");
          const content = m.content;
          if (m.role === "assistant" && !content && !(visibleToolCalls.length > 0)) return [];

          const msg: ChatMessage = {
            id: uid(),
            role: m.role as ChatRole,
            content,
          };
          if (m.toolCallId) msg.toolCallId = m.toolCallId;
          if (m.role === "assistant" && visibleToolCalls.length > 0) {
            msg.toolCalls = visibleToolCalls.map((t) => ({
              id: t.id,
              name: t.name,
              args: "",
              ...(t.label ? { label: t.label } : {}),
            }));
          }
          return [msg];
        });
        opts.onLoadMessages(loaded);
        chatIdRef.current = sessionId;
        setChatId(sessionId);
        const found = sessions.find((s) => s.id === sessionId);
        setChatTitle(found?.title ?? null);
      } catch (e) {
        showGlobalMessage().error(agentError(e, "加载历史失败"));
      }
    },
    [sessions, opts]
  );

  /** 开新对话 */
  const newChat = useCallback(() => {
    opts.onStopStream();
    opts.onClearMessages();
    clearUserActions();
    chatIdRef.current = null;
    setChatId(null);
    setChatTitle(null);
  }, [opts]);

  /** 拉取历史会话列表（按 updatedAt 倒序） */
  const loadSessions = useCallback(async () => {
    try {
      const data = await agentApi.listSessions(opts.projectId);
      setSessions(data ?? []);
    } catch (e) {
      showGlobalMessage().error(agentError(e, "加载历史列表失败"));
    }
  }, [opts.projectId]);

  /** 删除会话；若删的是当前会话则顺带开新对话 */
  const deleteChat = useCallback(
    async (sessionId: number) => {
      try {
        await agentApi.deleteSession(sessionId);
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (sessionId === chatId) newChat();
        showGlobalMessage().success("已删除会话");
      } catch (e) {
        showGlobalMessage().error(agentError(e, "删除失败"));
      }
    },
    [chatId, newChat]
  );

  /** 重命名当前会话 */
  const renameChat = useCallback(
    async (title: string) => {
      if (!chatId) return;
      try {
        await agentApi.renameSession(chatId, title);
        setChatTitle(title);
      } catch (e) {
        showGlobalMessage().error(agentError(e, "重命名失败"));
      }
    },
    [chatId]
  );

  return {
    chatId,
    chatTitle,
    setChatTitle,
    sessions,
    ensureSession,
    loadHistory,
    loadSessions,
    deleteChat,
    renameChat,
    newChat,
  };
}
