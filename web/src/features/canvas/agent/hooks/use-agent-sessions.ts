/**
 * Agent 会话管理 hook：会话列表加载与新建 / 切换 / 重命名 / 删除。
 * 与消息流 hook 分离，消息状态通过回调注入以避免双向耦合。
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppFeedback } from "@/components/ui/use-app-feedback";
import type { AgentSessionDto } from "@/features/canvas/agent/api";
import { agentApi } from "@/features/canvas/agent/api";
import { createSessionGate } from "@/features/canvas/agent/hooks/session-gate";
import { PROMOTE_TEXT_TOOLS } from "@/features/canvas/agent/tools/Meta";
import type { ChatMessage, ChatRole } from "@/features/canvas/agent/types";
import { clearUserActions } from "@/features/canvas/agent/user-action-tracker";
import { ApiError } from "@/lib/api/client";
import i18n from "@/lib/i18n/config";

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
  const { message } = useAppFeedback();
  const [chatId, setChatId] = useState<number | null>(null);
  const [chatTitle, setChatTitle] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSessionDto[]>([]);

  // 会话生命周期门闸（世代令牌 + 单飞）：ensureSession 在途时被 newChat / 切项目 /
  // 切会话重置，孤儿会话会被门闸放弃挂载；并发 ensure 共用一次创建
  const gate = useMemo(() => createSessionGate(), []);

  // 已删除会话登记：delete 在服务端确认后登记，迟到的 loadHistory 响应据此
  // 放弃重新挂载已删除的会话（R-AGENT-03 场景：删 A 与读 A 历史并发，
  // history 晚到时门闸世代未变，仅靠世代无法识别「目标已删除」）。
  // 会话 id 自增不复用，集合中的 id 恒指已删会话，不会误拦有效会话；
  // 切项目时清空（跨项目无残留意义）。
  const deletedSessionIdsRef = useRef<Set<number>>(new Set());

  // 会话列表世代：delete 在服务端确认后递增，使更早发起的在途列表读取失效
  // （其响应是删除前的服务端快照，应用即复活已删会话）。rename 不增删列表项，
  // 不参与此世代。
  const sessionsRevRef = useRef(0);

  // 切换项目时自动重置对话，避免旧项目的会话串到新项目。
  // state 重置用渲染期条件调整（React 官方推荐的 prop 变化重置模式），
  // 避免 effect 内同步 setState 触发级联渲染；门闸/停流/清消息副作用仍走 effect。
  const [prevProjectId, setPrevProjectId] = useState(opts.projectId);
  if (prevProjectId !== opts.projectId) {
    setPrevProjectId(opts.projectId);
    setChatId(null);
    setChatTitle(null);
  }

  useEffect(() => {
    gate.reset();
    deletedSessionIdsRef.current.clear();
    clearUserActions();
    opts.onStopStream();
    opts.onClearMessages();
  }, [opts.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 创建新会话（首条消息前调用），可选传入初始标题 */
  const ensureSession = useCallback(
    async (initialTitle?: string): Promise<number | null> => {
      try {
        const ref = await gate.ensure(
          (title) => agentApi.createSession(title, opts.projectId),
          initialTitle
        );
        // resolve 与本续体之间可能插入 reset（微任务间隙）：门闸已重置则该会话同为孤儿
        if (ref && gate.current?.id === ref.id) {
          setChatId(ref.id);
          if (ref.title) setChatTitle(ref.title);
          return ref.id;
        }
        return null;
      } catch (e) {
        message.error(agentError(e, i18n.t("agent.createSessionFailed")));
        return null;
      }
    },
    [gate, message, opts.projectId]
  );

  /** 加载历史消息（切换会话在途读取：登记世代，返回后校验身份未变才允许应用） */
  const loadHistory = useCallback(
    async (sessionId: number) => {
      // 先停掉当前会话的流式回合，避免回复继续追加进即将加载的另一份消息列表
      opts.onStopStream();
      // 切会话后旧会话期间积累的用户操作不应带进新会话
      clearUserActions();
      // 登记在途读取（递增世代）：期间发生任何身份变更（切项目 / 新对话 /
      // 更晚的切会话 / 新会话创建成功）都会使本次响应失效
      const gen = gate.beginLoad();
      try {
        const data = await agentApi.getSessionMessages(sessionId, opts.projectId);
        // 世代已变：陈旧响应整体丢弃——绝不写 UI / 门闸 / chatId（R-AGENT-01 根因围栏）
        if (!gate.isCurrent(gen)) return;
        // 目标会话在读取期间被删除：迟到响应绝不重新挂载已删会话（R-AGENT-03）。
        // 世代未变不足以证明目标仍存在——delete 不是身份变更，不影响世代
        if (deletedSessionIdsRef.current.has(sessionId)) return;
        // ghost 清理：回复型工具（promoteTextToContent）的回执行不进入 UI
        // （回复文本已在 assistant content 里）
        const messageUserCallIds = new Set(
          (data ?? []).flatMap((m) =>
            (m.toolCalls ?? []).filter((t) => PROMOTE_TEXT_TOOLS.has(t.name)).map((t) => t.id),
          ),
        );
        const loaded: ChatMessage[] = (data ?? []).flatMap((m) => {
          if (m.role === "tool" && m.toolCallId && messageUserCallIds.has(m.toolCallId)) return [];
          const visibleToolCalls = (m.toolCalls ?? []).filter((t) => !PROMOTE_TEXT_TOOLS.has(t.name));
          const content = m.content;
          // 内容与可视工具调用皆空的 assistant 行不进入 UI。这不是历史兼容：
          // 服务端 finishTurn 会为上游配对持久化此类行——纯回复型工具轮在模型
          // 零 delta 且工具参数无有效 text 时 content 落空串（行本身必须存在，
          // tool_call/result 才能配对续轮），实时流中它只是瞬时占位，历史加载
          // 进入 UI 则会在新一轮流式期间渲染成幽灵「思考中…」气泡
          if (m.role === "assistant" && !content && visibleToolCalls.length === 0) return [];

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
        // 应用前再停一次流：await 期间可能又发起了对新会话的流式回合，
        // 身份即将切换，不允许任何流跨过本次历史应用继续运行
        opts.onStopStream();
        opts.onLoadMessages(loaded);
        const found = sessions.find((s) => s.id === sessionId);
        gate.adopt({ id: sessionId, title: found?.title ?? null });
        setChatId(sessionId);
        setChatTitle(found?.title ?? null);
      } catch (e) {
        // 世代已变的失败静默：用户早已切走，报错提示只是噪音
        if (!gate.isCurrent(gen)) return;
        message.error(agentError(e, i18n.t("agent.loadHistoryFailed")));
      }
    },
    [gate, message, sessions, opts]
  );

  /** 开新对话 */
  const newChat = useCallback(() => {
    opts.onStopStream();
    opts.onClearMessages();
    clearUserActions();
    gate.reset();
    setChatId(null);
    setChatTitle(null);
  }, [gate, opts]);

  /**
   * 拉取历史会话列表（按 updatedAt 倒序）。
   * 纯读取不登记世代（避免孤儿化在途的会话创建）：快照当前世代，返回后仅当
   * 项目身份未再变更（切项目 / 新对话会 reset 递增）才应用（R-AGENT-02 围栏）。
   * 另比对列表世代：期间有 delete 完成则本响应是删除前的快照，应用会复活
   * 已删会话，整体丢弃（R-AGENT-03）。
   */
  const loadSessions = useCallback(async () => {
    const gen = gate.generation;
    const rev = sessionsRevRef.current;
    try {
      const data = await agentApi.listSessions(opts.projectId);
      if (!gate.isCurrent(gen)) return;
      if (rev !== sessionsRevRef.current) return;
      setSessions(data ?? []);
    } catch (e) {
      if (!gate.isCurrent(gen)) return;
      message.error(agentError(e, i18n.t("agent.loadSessionsFailed")));
    }
  }, [gate, message, opts.projectId]);

  /** 删除会话；若删的是当前会话则顺带开新对话 */
  const deleteChat = useCallback(
    async (sessionId: number) => {
      // 快照发起时的身份世代：await 返回后身份已变（用户切走）则本调用的
      // 本地收尾（含失败提示）不再对当前会话状态发言
      const gen = gate.generation;
      try {
        await agentApi.deleteSession(sessionId, opts.projectId);
        // 服务端已确认删除。列表过滤是函数式更新，与任何并发读取收敛一致，无条件执行；
        // 递增列表世代使在途的旧列表响应失效（其快照含已删会话，应用即复活）；
        // 登记已删 id，拦住同目标在途 loadHistory 的迟到响应
        sessionsRevRef.current += 1;
        deletedSessionIdsRef.current.add(sessionId);
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        // 「删的是当前会话则开新对话」以门闸实时身份判定：闭包 chatId 在 await
        // 期间可能已被切会话改写，用它会把新切换的会话清空（R-AGENT-03 根因）
        if (gate.current?.id === sessionId) newChat();
        message.success(i18n.t("agent.sessionDeleted"));
      } catch (e) {
        // 世代已变的失败静默：用户早已切走，报错提示只是噪音（与 loadHistory 同语义）
        if (!gate.isCurrent(gen)) return;
        message.error(agentError(e, i18n.t("agent.deleteFailed")));
      }
    },
    [gate, message, newChat, opts.projectId]
  );

  /** 重命名当前会话 */
  const renameChat = useCallback(
    async (title: string) => {
      if (!chatId) return;
      // 快照发起时的身份世代：await 返回后世代未变（期间无切会话 / 切项目 /
      // 新对话 / 创建成功）才允许改写标题——迟到响应绝不写进已切换的当前会话
      const gen = gate.generation;
      const renamedId = chatId;
      try {
        await agentApi.renameSession(renamedId, title, opts.projectId);
        if (!gate.isCurrent(gen)) return;
        setChatTitle(title);
      } catch (e) {
        // 世代已变的失败静默：用户早已切走，报错提示只是噪音（与 loadHistory 同语义）
        if (!gate.isCurrent(gen)) return;
        message.error(agentError(e, i18n.t("agent.renameFailed")));
      }
    },
    [chatId, gate, message, opts.projectId]
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
