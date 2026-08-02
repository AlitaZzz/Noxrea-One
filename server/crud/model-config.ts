import { prisma } from "@server/core/database/client";
import { stringifyJson, parseJsonObject, parseJsonArray } from "./_json";

// ── Model Config CRUD（对应 backend/app/crud/model_config.py） ──

// ── 反序列化工具 ──

function deserializeChannel<T extends { config: unknown; models: Array<{ capabilities: unknown }> }>(ch: T) {
  return {
    ...ch,
    config: ch.config ? parseJsonObject(ch.config) : null,
    models: ch.models.map((m) => ({
      ...m,
      capabilities: parseJsonArray(m.capabilities),
    })),
  };
}

// Channel
export async function getChannels(userId?: number) {
  const where = userId ? { userId } : {};
  const channels = await prisma.modelChannel.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { models: true },
  });
  return channels.map(deserializeChannel);
}

export async function getChannel(id: number) {
  const channel = await prisma.modelChannel.findUnique({
    where: { id },
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
  config?: Record<string, unknown>;
}) {
  const channel = await prisma.modelChannel.create({
    data: {
      userId: data.userId ?? null,
      name: data.name,
      baseUrl: data.baseUrl,
      apiKey: data.apiKey ?? "",
      protocol: data.protocol ?? "openai",
      config: data.config ? stringifyJson(data.config) : null,
    },
    include: { models: true },
  });
  return deserializeChannel(channel);
}

export async function updateChannel(
  id: number,
  data: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    protocol?: string;
    config?: Record<string, unknown>;
  }
) {
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (data.name !== undefined) updateData.name = data.name;
  if (data.baseUrl !== undefined) updateData.baseUrl = data.baseUrl;
  if (data.apiKey !== undefined) updateData.apiKey = data.apiKey;
  if (data.protocol !== undefined) updateData.protocol = data.protocol;
  if (data.config !== undefined)
    updateData.config = stringifyJson(data.config);

  const channel = await prisma.modelChannel.update({
    where: { id },
    data: updateData,
    include: { models: true },
  });
  return deserializeChannel(channel);
}

export async function deleteChannel(id: number) {
  return prisma.modelChannel.delete({ where: { id } });
}

// Model
export async function addModel(
  channelId: number,
  data: { name: string; capabilities?: string[] }
) {
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

export async function deleteModel(modelId: number) {
  return prisma.modelInfo.delete({ where: { id: modelId } });
}

export async function batchSetModels(
  channelId: number,
  models: Array<{
    name: string;
    capabilities?: string[];
  }>
) {
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
  capabilities: string[]
) {
  const model = await prisma.modelInfo.update({
    where: { id: modelId },
    data: { capabilities: stringifyJson(capabilities) },
  });
  return {
    ...model,
    capabilities: parseJsonArray(model.capabilities),
  };
}
