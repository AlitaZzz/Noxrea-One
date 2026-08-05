/**
 * AI 对话会话管理 hook：会话列表加载与新建 / 切换 / 重命名 / 删除。
 * 与消息流 use-chat-stream 分离，消息状态通过回调注入以避免双向耦合。
 */
"use client";

import { useCallback, useState } from "react";

import type { ChatMessage, ChatRole } from "@/hooks/use-chat-stream";
import { chatApi } from "@/lib/api";
import { showGlobalMessage } from "@/lib/global-message";

export interface SessionListItem {
  id: string;
  title: string;
  updatedAt: string;
}

let _seq = 0;
function uid() {
  _seq++;
  return `m_${Date.now()}_${_seq}`;
}

/**
 * 会话管理层：管理 chatId / chatTitle / sessions 列表 + CRUD 操作。
 *
 * 从 use-chat-stream.ts 拆出，使消息流和会话管理各司其职。
 * 消息状态的清空 / 加载由回调注入，避免双向耦合。
 */
export function useAgentSessions(opts: {
  /** 清空消息列表（newChat 时调用） */
  onClearMessages: () => void;
  /** 停止正在进行的流式请求（newChat / deleteChat 时调用） */
  onStopStream: () => void;
  /** 加载历史消息到 UI（切换会话时调用） */
  onLoadMessages: (messages: ChatMessage[]) => void;
}) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [chatTitle, setChatTitle] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);

  /** 创建新会话（首条消息前调用），可选传入初始标题 */
  const ensureSession = useCallback(
    async (initialTitle?: string): Promise<string | null> => {
      if (chatId) return chatId;
      try {
        const res = await chatApi.createSession(initialTitle);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { id: string; title?: string };
        setChatId(data.id);
        if (data.title) setChatTitle(data.title);
        return data.id;
      } catch {
        showGlobalMessage().error("创建会话失败");
        return null;
      }
    },
    [chatId]
  );

  /** 加载历史消息（切换会话时调用） */
  const loadHistory = useCallback(
    async (sessionId: string, skillNames?: Array<{ name: string; displayTitle?: string }>) => {
      try {
        const msgRes = await chatApi.getSessionMessages(sessionId);
        if (!msgRes.ok) throw new Error(`HTTP ${msgRes.status}`);
        const data = (await msgRes.json()) as Array<{
          role: string;
          content: string;
          skills?: string[];
        }>;
        const loaded: ChatMessage[] = (data ?? []).map((m) => {
          const skills = m.skills?.length
            ? m.skills.map((name) => {
                const meta = skillNames?.find((s) => s.name === name);
                return { name, displayTitle: meta?.displayTitle ?? name };
              })
            : undefined;
          return {
            id: uid(),
            role: m.role as ChatRole,
            content: m.content,
            ...(skills && skills.length ? { skills } : {}),
          };
        });
        opts.onLoadMessages(loaded);
        setChatId(sessionId);
        const found = sessions.find((s) => String(s.id) === String(sessionId));
        setChatTitle(found?.title ?? null);
      } catch {
        showGlobalMessage().error("加载历史失败");
      }
    },
    [sessions, opts]
  );

  /** 开新对话 */
  const newChat = useCallback(() => {
    opts.onStopStream();
    opts.onClearMessages();
    setChatId(null);
    setChatTitle(null);
  }, [opts]);

  /** 拉取历史会话列表（按 updatedAt 倒序） */
  const loadSessions = useCallback(async () => {
    try {
      const res = await chatApi.listSessions();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SessionListItem[];
      setSessions(data ?? []);
    } catch {
      showGlobalMessage().error("加载历史列表失败");
    }
  }, []);

  /** 删除会话；若删的是当前会话则顺带开新对话 */
  const deleteChat = useCallback(
    async (sessionId: string) => {
      try {
        const res = await chatApi.deleteSession(sessionId);
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
  const renameChat = useCallback(
    async (title: string) => {
      if (!chatId) return;
      try {
        const res = await chatApi.renameSession(chatId, title);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setChatTitle(title);
      } catch {
        showGlobalMessage().error("重命名失败");
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
