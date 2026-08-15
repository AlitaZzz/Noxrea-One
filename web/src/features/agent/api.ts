/**
 * Agent 相关 API 封装：会话管理、技能绑定、流式对话与工具结果回传。
 * 前端只需选技能 + 发消息 + 回传工具结果，不关心后端状态管理。
 */
import type { StreamAgentOptions, ToolResultOptions } from "@/features/agent/types";
import { apiRaw, apiStream } from "@/lib/api/client";

// ── 会话 CRUD ──

/** 创建会话，可选初始标题和项目 ID。 */
export async function createSession(initialTitle?: string, projectId?: number): Promise<Response> {
  const body: Record<string, unknown> = {};
  if (initialTitle) body.title = initialTitle;
  if (projectId != null) body.projectId = projectId;
  return apiRaw("/api/agent/sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** 拉取会话列表（按 updatedAt 倒序），可选按项目过滤。 */
export async function listSessions(projectId?: number): Promise<Response> {
  const url = projectId != null
    ? `/api/agent/sessions?projectId=${encodeURIComponent(projectId)}`
    : "/api/agent/sessions";
  return apiRaw(url);
}

/** 获取会话详情（含 activeSkill / skillStatus）。 */
export async function getSession(sessionId: string): Promise<Response> {
  return apiRaw(`/api/agent/sessions/${sessionId}`);
}

/** 加载会话历史消息。 */
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

// ── 技能管理 ──

/** 绑定/切换技能到会话。 */
export async function setSkill(sessionId: string, skillName: string): Promise<Response> {
  return apiRaw(`/api/agent/sessions/${sessionId}/skill`, {
    method: "POST",
    body: JSON.stringify({ skillName }),
  });
}

/** 清除技能（回到普通对话模式）。 */
export async function clearSkill(sessionId: string): Promise<Response> {
  return apiRaw(`/api/agent/sessions/${sessionId}/skill`, { method: "DELETE" });
}

/** 拉取可用技能列表。 */
export async function listSkills(): Promise<Response> {
  return apiRaw("/api/agent/skills");
}

// ── 流式对话 ──

/** 发起流式对话，返回原始 Response。 */
export async function streamAgent(opts: StreamAgentOptions): Promise<Response> {
  const params = new URLSearchParams({
    model: opts.modelId,
  });
  const body: Record<string, unknown> = { content: opts.content };
  if (opts.refImages?.length) body.refImages = opts.refImages;
  if (opts.skillName) body.skillName = opts.skillName;
  return apiStream(`/api/agent/sessions/${opts.sessionId}/stream?${params.toString()}`, {
    method: "POST",
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}

// ── 工具结果回传 ──

/** 提交工具执行结果，后端自动续轮调 LLM。返回 SSE 流。 */
export async function submitToolResult(opts: ToolResultOptions): Promise<Response> {
  const params = new URLSearchParams({ model: opts.modelId });
  return apiStream(
    `/api/agent/sessions/${opts.sessionId}/tool-result?${params.toString()}`,
    {
      method: "POST",
      body: JSON.stringify({ toolCallId: opts.toolCallId, result: opts.result }),
      signal: opts.signal,
    },
  );
}

/** Agent 接口命名空间。 */
export const agentApi = {
  createSession,
  listSessions,
  getSession,
  getSessionMessages,
  deleteSession,
  renameSession,
  setSkill,
  clearSkill,
  listSkills,
  streamAgent,
  submitToolResult,
};
