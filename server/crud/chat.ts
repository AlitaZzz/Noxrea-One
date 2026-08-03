import { prisma } from "@server/core/database/client";
import { stringifyJson, parseJsonArray } from "./_json";
import type { ChatSession, ChatMessage } from "@prisma/client";

// ── Chat CRUD（按画布 project 独立的对话会话） ──

export type ChatRole = "user" | "assistant";

export async function createSession(data: {
  userId: number;
  projectId?: number | null;
  title?: string;
}) {
  const session = await prisma.chatSession.create({
    data: {
      userId: data.userId,
      projectId: data.projectId ?? null,
      title: data.title ?? "New Chat",
    },
  });
  return deserializeSession(session);
}

export async function listSessions(userId: number, projectId?: number | null) {
  const sessions = await prisma.chatSession.findMany({
    where: { userId, projectId: projectId ?? null },
    orderBy: { updatedAt: "desc" },
  });
  return sessions.map(deserializeSession);
}

export async function getSession(id: number, userId: number) {
  const session = await prisma.chatSession.findFirst({
    where: { id, userId },
  });
  return session ? deserializeSession(session) : null;
}

export async function renameSession(id: number, userId: number, title: string) {
  const session = await prisma.chatSession.updateMany({
    where: { id, userId },
    data: { title, updatedAt: new Date() },
  });
  return session.count === 1;
}

export async function deleteSession(id: number, userId: number) {
  return prisma.chatSession.deleteMany({
    where: { id, userId },
  });
}

export async function touchSession(id: number) {
  await prisma.chatSession.update({
    where: { id },
    data: { updatedAt: new Date() },
  });
}

export async function createMessage(data: {
  sessionId: number;
  role: ChatRole;
  content: string;
  refImages?: string[];
}) {
  const msg = await prisma.chatMessage.create({
    data: {
      sessionId: data.sessionId,
      role: data.role,
      content: data.content,
      refImages: data.refImages ? stringifyJson(data.refImages) : null,
    },
  });
  return deserializeMessage(msg);
}

export async function listMessages(sessionId: number) {
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
  });
  return messages.map(deserializeMessage);
}

// ── 反序列化工具 ──

function deserializeSession(session: ChatSession) {
  return { ...session };
}

function deserializeMessage(message: ChatMessage) {
  return {
    ...message,
    refImages: parseJsonArray(message.refImages),
  };
}
