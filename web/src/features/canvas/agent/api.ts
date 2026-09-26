/**
 * 画布 Agent API 封装：会话管理、流式对话与工具结果回传。
 * 前端只需发消息 + 执行工具回传结果，不关心后端状态管理。
 */
import type { StreamAgentOptions, ToolResultOptions } from "@/features/canvas/agent/types";
import { api, apiStream } from "@/lib/api/client";

/** 会话实体（创建 / 列表 / 读取共用；id 为后端自增整数） */
export interface AgentSessionDto {
  id: number;
  title: string;
  updatedAt: string;
}

/** 历史消息落库形态（UI 加载时再加工成 ChatMessage） */
export interface AgentMessageDto {
  role: string;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: Array<{ id: string; name: string; label?: string; args?: Record<string, unknown> }>;
}

// ── 会话 CRUD ──

/** 创建会话，可选初始标题和项目 ID。 */
export async function createSession(initialTitle?: string, projectId?: string): Promise<AgentSessionDto> {
  const body: Record<string, unknown> = {};
  if (initialTitle) body.title = initialTitle;
  if (projectId != null) body.projectId = projectId;
  return api<AgentSessionDto>("/api/agent/sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** 拉取会话列表（按 updatedAt 倒序），可选按项目过滤。 */
export async function listSessions(projectId?: string): Promise<AgentSessionDto[]> {
  const url = projectId != null
    ? `/api/agent/sessions?projectId=${encodeURIComponent(projectId)}`
    : "/api/agent/sessions";
  return api<AgentSessionDto[]>(url);
}

/** 获取会话历史消息。 */
export async function getSessionMessages(sessionId: number): Promise<AgentMessageDto[]> {
  return api<AgentMessageDto[]>(`/api/agent/sessions/${sessionId}/messages`);
}

/** 删除会话。 */
export async function deleteSession(sessionId: number): Promise<void> {
  await api(`/api/agent/sessions/${sessionId}`, { method: "DELETE" });
}

/** 重命名会话。 */
export async function renameSession(sessionId: number, title: string): Promise<void> {
  await api(`/api/agent/sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

// ── 流式对话 ──

/** 发起流式对话，返回原始 Response（SSE）。 */
export async function streamAgent(opts: StreamAgentOptions): Promise<Response> {
  const params = new URLSearchParams({ model: opts.modelId });
  if (opts.providerId) params.set("providerId", opts.providerId);
  const body: Record<string, unknown> = { content: opts.content };
  if (opts.refImages?.length) body.refImages = opts.refImages;
  if (opts.canvasState !== undefined) body.canvasState = opts.canvasState;
  if (opts.userActions !== undefined) body.userActions = opts.userActions;
  return apiStream(`/api/agent/sessions/${opts.sessionId}/stream?${params.toString()}`, {
    method: "POST",
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}

// ── 工具结果回传 ──

/** 提交本轮全部工具执行结果，后端自动续轮调 LLM。返回 SSE 流。 */
export async function submitToolResults(opts: ToolResultOptions): Promise<Response> {
  const params = new URLSearchParams({ model: opts.modelId });
  if (opts.providerId) params.set("providerId", opts.providerId);
  return apiStream(
    `/api/agent/sessions/${opts.sessionId}/tool-result?${params.toString()}`,
    {
      method: "POST",
      body: JSON.stringify({
        results: opts.results,
        ...(opts.canvasState !== undefined ? { canvasState: opts.canvasState } : {}),
        ...(opts.userActions !== undefined ? { userActions: opts.userActions } : {}),
      }),
      signal: opts.signal,
    },
  );
}

/** Agent 接口命名空间。 */
export const agentApi = {
  createSession,
  listSessions,
  getSessionMessages,
  deleteSession,
  renameSession,
  streamAgent,
  submitToolResults,
};
