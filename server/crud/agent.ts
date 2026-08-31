import { prisma } from "@server/core/database/client";
import { stringifyJson, parseJsonArray } from "./_json";
/**
 * Agent 会话 CRUD。
 * 管理按画布工程隔离的 Agent 会话与消息的创建与读取。
 * 技能绑定在 session 级别，消息不再携带 skills 字段。
 */
import type { AgentSession, AgentMessage } from "@prisma/client";

export type AgentRole = "user" | "assistant" | "tool";

// ── Session ──

export async function createSession(data: {
  userId: number;
  projectId?: string | null;
  title?: string;
}) {
  const session = await prisma.agentSession.create({
    data: {
      userId: data.userId,
      projectId: data.projectId ?? null,
      title: data.title ?? "New Chat",
    },
  });
  return deserializeSession(session);
}

export async function listSessions(userId: number, projectId?: string | null) {
  const sessions = await prisma.agentSession.findMany({
    where: { userId, projectId: projectId ?? null },
    orderBy: { updatedAt: "desc" },
  });
  return sessions.map(deserializeSession);
}

export async function getSession(id: number, userId: number) {
  const session = await prisma.agentSession.findFirst({
    where: { id, userId },
  });
  return session ? deserializeSession(session) : null;
}

export async function renameSession(id: number, userId: number, title: string) {
  const session = await prisma.agentSession.updateMany({
    where: { id, userId },
    data: { title, updatedAt: new Date() },
  });
  return session.count === 1;
}

export async function deleteSession(id: number, userId: number) {
  return prisma.agentSession.deleteMany({
    where: { id, userId },
  });
}

export async function touchSession(id: number) {
  await prisma.agentSession.update({
    where: { id },
    data: { updatedAt: new Date() },
  });
}

// ── Skill 管理 ──

export async function setSkill(id: number, userId: number, skillName: string) {
  const session = await prisma.agentSession.updateMany({
    where: { id, userId },
    data: { activeSkill: skillName, skillStatus: "active", updatedAt: new Date() },
  });
  return session.count === 1;
}

export async function clearSkill(id: number, userId: number) {
  const session = await prisma.agentSession.updateMany({
    where: { id, userId },
    data: { activeSkill: null, skillStatus: "idle", updatedAt: new Date() },
  });
  return session.count === 1;
}

export async function completeSkill(id: number) {
  await prisma.agentSession.update({
    where: { id },
    data: { activeSkill: null, skillStatus: "completed", updatedAt: new Date() },
  });
}

// ── Message ──

export async function createMessage(data: {
  sessionId: number;
  role: AgentRole;
  content: string;
  refImages?: string[];
  toolCallId?: string | null;
  toolName?: string | null;
}) {
  const msg = await prisma.agentMessage.create({
    data: {
      sessionId: data.sessionId,
      role: data.role,
      content: data.content,
      refImages: data.refImages?.length ? stringifyJson(data.refImages) : null,
      toolCallId: data.toolCallId ?? null,
      toolName: data.toolName ?? null,
    },
  });
  return deserializeMessage(msg);
}

export async function listMessages(sessionId: number) {
  const messages = await prisma.agentMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
  });
  return messages.map(deserializeMessage);
}

// ── 反序列化 ──

function deserializeSession(session: AgentSession) {
  return { ...session };
}

function deserializeMessage(message: AgentMessage) {
  return {
    ...message,
    refImages: parseJsonArray(message.refImages),
  };
}
