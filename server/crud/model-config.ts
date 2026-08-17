/**
 * 模型渠道配置 CRUD。
 * 管理 API 渠道、模型能力与配置项的读写，并处理配置 JSON 字段的反序列化。
 */
import { prisma } from "@server/core/database/client";
import { stringifyJson, parseJsonArray } from "./_json";

function deserializeChannel<T extends { models: Array<{ capabilities: unknown }> }>(ch: T) {
  return {
    ...ch,
    models: ch.models.map((m) => ({
      ...m,
      capabilities: parseJsonArray(m.capabilities),
    })),
  };
}

// Channel
export async function getChannels(userId: number) {
  const channels = await prisma.modelChannel.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { models: true },
  });
  return channels.map(deserializeChannel);
}

export async function getChannel(id: number, userId: number) {
  const channel = await prisma.modelChannel.findFirst({
    where: { id, userId },
    include: { models: true },
  });
  return channel ? deserializeChannel(channel) : null;
}

export async function createChannel(data: {
  userId?: number;
  name: string;
  baseUrl: string;
  apiKey?: string;
  protocol?: string;
}) {
  const channel = await prisma.modelChannel.create({
    data: {
      userId: data.userId ?? null,
      name: data.name,
      baseUrl: data.baseUrl,
      apiKey: data.apiKey ?? "",
      protocol: data.protocol ?? "openai",
    },
    include: { models: true },
  });
  return deserializeChannel(channel);
}

export async function updateChannel(
  id: number,
  userId: number,
  data: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    protocol?: string;
  }
) {
  const existing = await prisma.modelChannel.findFirst({ where: { id, userId } });
  if (!existing) return null;
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (data.name !== undefined) updateData.name = data.name;
  if (data.baseUrl !== undefined) updateData.baseUrl = data.baseUrl;
  if (data.apiKey !== undefined) updateData.apiKey = data.apiKey;
  if (data.protocol !== undefined) updateData.protocol = data.protocol;

  const channel = await prisma.modelChannel.update({
    where: { id },
    data: updateData,
    include: { models: true },
  });
  return deserializeChannel(channel);
}

export async function deleteChannel(id: number, userId: number) {
  return prisma.modelChannel.deleteMany({ where: { id, userId } });
}

// Model
export async function addModel(
  channelId: number,
  userId: number,
  data: { name: string; capabilities?: string[] }
) {
  const channel = await prisma.modelChannel.findFirst({ where: { id: channelId, userId } });
  if (!channel) return null;

  const model = await prisma.modelInfo.create({
    data: {
      channelId,
      name: data.name,
      capabilities: stringifyJson(data.capabilities ?? []),
    },
  });
  return {
    ...model,
    capabilities: parseJsonArray(model.capabilities),
  };
}

export async function deleteModel(modelId: number, userId: number) {
  return prisma.modelInfo.deleteMany({
    where: { id: modelId, channel: { userId } },
  });
}

export async function batchSetModels(
  channelId: number,
  userId: number,
  models: Array<{
    name: string;
    capabilities?: string[];
  }>
) {
  const channel = await prisma.modelChannel.findFirst({ where: { id: channelId, userId } });
  if (!channel) return null;

  return prisma.$transaction(async (tx) => {
    await tx.modelInfo.deleteMany({ where: { channelId } });

    const data = models.map((m) => ({
      channelId,
      name: m.name,
      capabilities: stringifyJson(m.capabilities ?? []),
    }));

    await tx.modelInfo.createMany({ data });

    const result = await tx.modelInfo.findMany({ where: { channelId } });
    return result.map((m) => ({
      ...m,
      capabilities: parseJsonArray(m.capabilities),
    }));
  });
}

export async function updateModelCapability(
  modelId: number,
  userId: number,
  capabilities: string[]
) {
  const existing = await prisma.modelInfo.findFirst({
    where: { id: modelId, channel: { userId } },
  });
  if (!existing) return null;

  const model = await prisma.modelInfo.update({
    where: { id: modelId },
    data: { capabilities: stringifyJson(capabilities) },
  });
  return {
    ...model,
    capabilities: parseJsonArray(model.capabilities),
  };
}
