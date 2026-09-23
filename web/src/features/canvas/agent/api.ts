/**
 * 画布 Agent API 封装：会话管理、流式对话与工具结果回传。
 * 前端只需发消息 + 执行工具回传结果，不关心后端状态管理。
 */
import type { StreamAgentOptions, ToolResultOptions } from "@/features/canvas/agent/types";
import { apiRaw, apiStream } from "@/lib/api/client";

// ── 会话 CRUD ──

/** 创建会话，可选初始标题和项目 ID。 */
export async function createSession(initialTitle?: string, projectId?: string): Promise<Response> {
  const body: Record<string, unknown> = {};
  if (initialTitle) body.title = initialTitle;
  if (projectId != null) body.projectId = projectId;
  return apiRaw("/api/agent/sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** 拉取会话列表（按 updatedAt 倒序），可选按项目过滤。 */
export async function listSessions(projectId?: string): Promise<Response> {
  const url = projectId != null
    ? `/api/agent/sessions?projectId=${encodeURIComponent(projectId)}`
    : "/api/agent/sessions";
  return apiRaw(url);
}

/** 获取会话历史消息。 */
export async function getSessionMessages(sessionId: string): Promise<Response> {
  return apiRaw(`/api/agent/sessions/${sessionId}/messages`);
}

/** 删除会话。 */
export async function deleteSession(sessionId: string): Promise<Response> {
  return apiRaw(`/api/agent/sessions/${sessionId}`, { method: "DELETE" });
}

/** 重命名会话。 */
export async function renameSession(sessionId: string, title: string): Promise<Response> {
  return apiRaw(`/api/agent/sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

// ── 流式对话 ──

/** 发起流式对话，返回原始 Response。 */
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
