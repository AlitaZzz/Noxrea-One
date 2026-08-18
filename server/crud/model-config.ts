/**
 * 模型供应商配置 CRUD。
 * 管理 API 供应商、模型能力与配置项的读写，并处理配置 JSON 字段的反序列化。
 */
import { prisma } from "@server/core/database/client";
import { stringifyJson, parseJsonArray } from "./_json";

function deserializeProvider<T extends { models: Array<{ capabilities: unknown }> }>(ch: T) {
  return {
    ...ch,
    models: ch.models.map((m) => ({
      ...m,
      capabilities: parseJsonArray(m.capabilities),
    })),
  };
}

// Provider
export async function getProviders(userId: number) {
  const providers = await prisma.modelProvider.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { models: true },
  });
  return providers.map(deserializeProvider);
}

export async function getProvider(id: number, userId: number) {
  const provider = await prisma.modelProvider.findFirst({
    where: { id, userId },
    include: { models: true },
  });
  return provider ? deserializeProvider(provider) : null;
}

export async function createProvider(data: {
  userId?: number;
  name: string;
  baseUrl: string;
  apiKey?: string;
  protocol?: string;
}) {
  const provider = await prisma.modelProvider.create({
    data: {
      userId: data.userId ?? null,
      name: data.name,
      baseUrl: data.baseUrl,
      apiKey: data.apiKey ?? "",
      protocol: data.protocol ?? "openai",
    },
    include: { models: true },
  });
  return deserializeProvider(provider);
}

export async function updateProvider(
  id: number,
  userId: number,
  data: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    protocol?: string;
  }
) {
  const existing = await prisma.modelProvider.findFirst({ where: { id, userId } });
  if (!existing) return null;
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (data.name !== undefined) updateData.name = data.name;
  if (data.baseUrl !== undefined) updateData.baseUrl = data.baseUrl;
  if (data.apiKey !== undefined) updateData.apiKey = data.apiKey;
  if (data.protocol !== undefined) updateData.protocol = data.protocol;

  const provider = await prisma.modelProvider.update({
    where: { id },
    data: updateData,
    include: { models: true },
  });
  return deserializeProvider(provider);
}

export async function deleteProvider(id: number, userId: number) {
  return prisma.modelProvider.deleteMany({ where: { id, userId } });
}

// Model
export async function addModel(
  providerId: number,
  userId: number,
  data: { name: string; capabilities?: string[] }
) {
  const provider = await prisma.modelProvider.findFirst({ where: { id: providerId, userId } });
  if (!provider) return null;

  const model = await prisma.modelInfo.create({
    data: {
      providerId,
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
    where: { id: modelId, provider: { userId } },
  });
}

export async function batchSetModels(
  providerId: number,
  userId: number,
  models: Array<{
    name: string;
    capabilities?: string[];
  }>
) {
  const provider = await prisma.modelProvider.findFirst({ where: { id: providerId, userId } });
  if (!provider) return null;

  return prisma.$transaction(async (tx) => {
    await tx.modelInfo.deleteMany({ where: { providerId } });

    const data = models.map((m) => ({
      providerId,
      name: m.name,
      capabilities: stringifyJson(m.capabilities ?? []),
    }));

    await tx.modelInfo.createMany({ data });

    const result = await tx.modelInfo.findMany({ where: { providerId } });
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
    where: { id: modelId, provider: { userId } },
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
