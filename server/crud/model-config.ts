import { prisma } from "@server/core/database/client";
import { stringifyJson } from "./_json";

// ── Model Config CRUD（对应 backend/app/crud/model_config.py） ──

// Channel
export async function getChannels(userId?: number) {
  const where = userId ? { userId } : {};
  return prisma.modelChannel.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { models: true },
  });
}

export async function getChannel(id: number) {
  return prisma.modelChannel.findUnique({
    where: { id },
    include: { models: true },
  });
}

export async function createChannel(data: {
  userId?: number;
  name: string;
  baseUrl: string;
  apiKey?: string;
  protocol?: string;
  config?: Record<string, unknown>;
}) {
  return prisma.modelChannel.create({
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

  return prisma.modelChannel.update({
    where: { id },
    data: updateData,
    include: { models: true },
  });
}

export async function deleteChannel(id: number) {
  return prisma.modelChannel.delete({ where: { id } });
}

// Model
export async function addModel(
  channelId: number,
  data: { name: string; capabilities?: string[]; inferredCapabilities?: string[] }
) {
  return prisma.modelInfo.create({
    data: {
      channelId,
      name: data.name,
      capabilities: stringifyJson(data.capabilities ?? []),
      inferredCapabilities: stringifyJson(data.inferredCapabilities ?? []),
    },
  });
}

export async function deleteModel(modelId: number) {
  return prisma.modelInfo.delete({ where: { id: modelId } });
}

export async function batchSetModels(
  channelId: number,
  models: Array<{
    name: string;
    capabilities?: string[];
    inferredCapabilities?: string[];
  }>
) {
  return prisma.$transaction(async (tx) => {
    await tx.modelInfo.deleteMany({ where: { channelId } });

    const data = models.map((m) => ({
      channelId,
      name: m.name,
      capabilities: stringifyJson(m.capabilities ?? []),
      inferredCapabilities: stringifyJson(m.inferredCapabilities ?? []),
    }));

    await tx.modelInfo.createMany({ data });

    return tx.modelInfo.findMany({ where: { channelId } });
  });
}

export async function updateModelCapability(
  modelId: number,
  capabilities: string[]
) {
  return prisma.modelInfo.update({
    where: { id: modelId },
    data: { capabilities: stringifyJson(capabilities) },
  });
}
