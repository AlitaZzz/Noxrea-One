/**
 * 对话（Chat）相关 API 封装：会话管理、历史消息、技能列表与流式对话。
 */
import { apiRaw, apiStream } from "./client";

/** 创建会话，可选初始标题。返回原始 Response（调用方解析 { id, title }）。 */
export async function createSession(initialTitle?: string): Promise<Response> {
  return apiRaw("/api/chat/sessions", {
    method: "POST",
    body: JSON.stringify(initialTitle ? { title: initialTitle } : {}),
  });
}

/** 拉取会话列表（按 updatedAt 倒序）。 */
export async function listSessions(): Promise<Response> {
  return apiRaw("/api/chat/sessions");
}

/** 加载会话历史消息。 */
export async function getSessionMessages(sessionId: string): Promise<Response> {
  return apiRaw(`/api/chat/sessions/${sessionId}/messages`);
}

/** 删除会话。 */
export async function deleteSession(sessionId: string): Promise<Response> {
  return apiRaw(`/api/chat/sessions/${sessionId}`, { method: "DELETE" });
}

/** 重命名会话。 */
export async function renameSession(sessionId: string, title: string): Promise<Response> {
  return apiRaw(`/api/chat/sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

/** 拉取可用技能列表。 */
export async function listSkills(): Promise<Response> {
  return apiRaw("/api/chat/skills");
}

export interface StreamChatOptions {
  sessionId: string;
  modelId: string;
  agent?: boolean;
  messages: unknown[];
  skills?: { name: string }[];
  signal?: AbortSignal;
}

/** 发起流式对话，返回原始 Response。 */
export async function streamChat(opts: StreamChatOptions): Promise<Response> {
  const params = new URLSearchParams({
    sessionId: opts.sessionId,
    model: opts.modelId,
    agent: opts.agent ? "1" : "0",
  });
  const body: Record<string, unknown> = { messages: opts.messages };
  if (opts.skills && opts.skills.length > 0) body.skills = opts.skills.map((s) => s.name);
  return apiStream(`/api/chat/stream?${params.toString()}`, {
    method: "POST",
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}

/** 对话接口命名空间，按业务聚合上述函数。 */
export const chatApi = {
  createSession,
  listSessions,
  getSessionMessages,
  deleteSession,
  renameSession,
  listSkills,
  streamChat,
};
