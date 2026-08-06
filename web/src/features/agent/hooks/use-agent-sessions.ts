/**
 * Agent 会话管理 hook：会话列表加载与新建 / 切换 / 重命名 / 删除。
 * 与消息流 hook 分离，消息状态通过回调注入以避免双向耦合。
 */
"use client";

import { useCallback, useEffect, useState } from "react";

import type { ChatMessage, ChatRole, SessionListItem } from "@/features/agent/types";
import { agentApi } from "@/features/agent/api";
import { showGlobalMessage } from "@/lib/global-message";

let _seq = 0;
function uid() {
  _seq++;
  return `m_${Date.now()}_${_seq}`;
}

/**
 * 会话管理层：管理 chatId / chatTitle / sessions 列表 + CRUD 操作。
 *
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
  projectId?: number;
}) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [chatTitle, setChatTitle] = useState<string | null>(null);
  const [activeSkill, setActiveSkill] = useState<string | null>(null);
  const [skillStatus, setSkillStatus] = useState<string>("idle");
  const [sessions, setSessions] = useState<SessionListItem[]>([]);

  // 切换项目时自动重置对话，避免旧项目的会话串到新项目
  useEffect(() => {
    opts.onStopStream();
    opts.onClearMessages();
    setChatId(null);
    setChatTitle(null);
    setActiveSkill(null);
    setSkillStatus("idle");
  }, [opts.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 创建新会话（首条消息前调用），可选传入初始标题 */
  const ensureSession = useCallback(
    async (initialTitle?: string): Promise<string | null> => {
      if (chatId) return chatId;
      try {
        const res = await agentApi.createSession(initialTitle, opts.projectId);
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
    async (sessionId: string) => {
      try {
        const [msgRes, sessRes] = await Promise.all([
          agentApi.getSessionMessages(sessionId),
          agentApi.getSession(sessionId),
        ]);
        if (!msgRes.ok) throw new Error(`HTTP ${msgRes.status}`);
        const data = (await msgRes.json()) as Array<{
          role: string;
          content: string;
          toolCallId?: string;
          toolName?: string;
        }>;
        const loaded: ChatMessage[] = (data ?? []).map((m) => ({
          id: uid(),
          role: m.role as ChatRole,
          content: m.content,
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        }));
        opts.onLoadMessages(loaded);
        setChatId(sessionId);
        const found = sessions.find((s) => String(s.id) === String(sessionId));
        setChatTitle(found?.title ?? null);
        if (sessRes.ok) {
          const sess = (await sessRes.json()) as { activeSkill?: string | null; skillStatus?: string };
          setActiveSkill(sess.activeSkill ?? null);
          setSkillStatus(sess.skillStatus ?? "idle");
        }
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
    setActiveSkill(null);
    setSkillStatus("idle");
  }, [opts]);

  /** 拉取历史会话列表（按 updatedAt 倒序） */
  const loadSessions = useCallback(async () => {
    try {
      const res = await agentApi.listSessions(opts.projectId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SessionListItem[];
      setSessions(data ?? []);
    } catch {
      showGlobalMessage().error("加载历史列表失败");
    }
  }, [opts.projectId]);

  /** 删除会话；若删的是当前会话则顺带开新对话 */
  const deleteChat = useCallback(
    async (sessionId: string) => {
      try {
        const res = await agentApi.deleteSession(sessionId);
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
        const res = await agentApi.renameSession(chatId, title);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setChatTitle(title);
      } catch {
        showGlobalMessage().error("重命名失败");
      }
    },
    [chatId]
  );

  /** 绑定/切换技能 */
  const bindSkill = useCallback(
    async (skillName: string) => {
      if (!chatId) return;
      try {
        const res = await agentApi.setSkill(chatId, skillName);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setActiveSkill(skillName);
        setSkillStatus("active");
      } catch {
        showGlobalMessage().error("技能绑定失败");
      }
    },
    [chatId]
  );

  /** 清除技能 */
  const removeSkill = useCallback(
    async () => {
      if (!chatId) return;
      try {
        const res = await agentApi.clearSkill(chatId);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setActiveSkill(null);
        setSkillStatus("idle");
      } catch {
        showGlobalMessage().error("技能清除失败");
      }
    },
    [chatId]
  );

  return {
    chatId,
    chatTitle,
    setChatTitle,
    activeSkill,
    skillStatus,
    setActiveSkill,
    setSkillStatus,
    sessions,
    ensureSession,
    loadHistory,
    loadSessions,
    deleteChat,
    renameChat,
    newChat,
    bindSkill,
    removeSkill,
  };
}
