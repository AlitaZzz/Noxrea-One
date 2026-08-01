import { prisma } from "@server/core/database/client";
import { stringifyJson, parseJsonObject } from "./_json";

// ── Asset CRUD（对应 backend/app/crud/asset.py） ──

// ── Folders ──

export async function getFolders(userId: number, spaceKey = "personal") {
  return prisma.assetFolder.findMany({
    where: { userId, spaceKey },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { items: true } },
    },
  });
}

export async function getFolder(id: number) {
  return prisma.assetFolder.findUnique({
    where: { id },
    include: { _count: { select: { items: true } } },
  });
}

export async function createFolder(
  userId: number,
  data: { name: string; spaceKey?: string; parentId?: number | null }
) {
  return prisma.assetFolder.create({
    data: {
      userId,
      name: data.name,
      spaceKey: data.spaceKey ?? "personal",
      parentId: data.parentId ?? null,
    },
    include: { _count: { select: { items: true } } },
  });
}

export async function updateFolder(id: number, name: string) {
  return prisma.assetFolder.update({
    where: { id },
    data: { name },
    include: { _count: { select: { items: true } } },
  });
}

export async function deleteFolder(id: number) {
  await prisma.assetItem.updateMany({
    where: { folderId: id },
    data: { folderId: null },
  });
  return prisma.assetFolder.delete({ where: { id } });
}

// ── Items ──

export async function getAssets(params: {
  userId?: number;
  folderId?: number;
  type?: string;
  search?: string;
  spaceKey?: string;
  skip?: number;
  limit?: number;
}) {
  const where: Record<string, unknown> = {};

  if (params.userId !== undefined) where.userId = params.userId;
  // -1 表示「未分类」（folderId IS NULL），由前端 assets-store.ts 传入
  if (params.folderId === -1) {
    where.folderId = null;
  } else if (params.folderId !== undefined) {
    where.folderId = params.folderId;
  }
  if (params.type) where.type = params.type;
  if (params.spaceKey) where.spaceKey = params.spaceKey;
  if (params.search) {
    where.name = { contains: params.search };
  }

  const [items, total] = await Promise.all([
    prisma.assetItem.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: params.skip ?? 0,
      take: params.limit ?? 20,
    }),
    prisma.assetItem.count({ where }),
  ]);

  return { items, total };
}

export async function getAsset(id: number) {
  return prisma.assetItem.findUnique({ where: { id } });
}

export async function createAsset(data: {
  userId: number;
  name?: string;
  type?: string;
  width?: number;
  height?: number;
  description?: string;
  tags?: string[];
  extraData?: Record<string, unknown>;
  folderId?: number | null;
  spaceKey?: string;
}) {
  return prisma.assetItem.create({
    data: {
      userId: data.userId,
      name: data.name ?? "Untitled",
      type: data.type ?? "other",
      width: data.width ?? 0,
      height: data.height ?? 0,
      description: data.description ?? "",
      tags: stringifyJson(data.tags ?? []),
      extraData: stringifyJson(data.extraData ?? {}),
      folderId: data.folderId ?? null,
      spaceKey: data.spaceKey ?? "personal",
    },
  });
}

export async function createAssetsBatch(
  items: Array<{
    userId: number;
    name?: string;
    type?: string;
    width?: number;
    height?: number;
    description?: string;
    tags?: string[];
    extraData?: Record<string, unknown>;
    folderId?: number | null;
    spaceKey?: string;
  }>
) {
  const data = items.map((item) => ({
    userId: item.userId,
    name: item.name ?? "Untitled",
    type: item.type ?? "other",
    width: item.width ?? 0,
    height: item.height ?? 0,
    description: item.description ?? "",
    tags: stringifyJson(item.tags ?? []),
    extraData: stringifyJson(item.extraData ?? {}),
    folderId: item.folderId ?? null,
    spaceKey: item.spaceKey ?? "personal",
  }));

  await prisma.assetItem.createMany({ data });

  return prisma.assetItem.findMany({
    where: { userId: items[0]?.userId },
    orderBy: { id: "desc" },
    take: items.length,
  });
}

export async function updateAsset(
  id: number,
  updates: Record<string, unknown>
) {
  const data: Record<string, unknown> = { updatedAt: new Date() };

  // 统一的字段映射表：snake_case 请求参数 → camelCase DB 字段
  const fieldMap: Record<string, string> = {
    name: "name",
    type: "type",
    width: "width",
    height: "height",
    description: "description",
    folder_id: "folderId",
    space_key: "spaceKey",
    tags: "tags",
    extra_data: "extraData",
  };

  for (const [key, value] of Object.entries(updates)) {
    const mappedKey = fieldMap[key] ?? key;
    // JSON 字段需要序列化
    if (mappedKey === "tags" || mappedKey === "extraData") {
      data[mappedKey] = stringifyJson(value);
    } else {
      data[mappedKey] = value;
    }
  }

  return prisma.assetItem.update({ where: { id }, data });
}

export async function updateAssetsBatch(
  ids: number[],
  updates: Record<string, unknown>
) {
  const data: Record<string, unknown> = { updatedAt: new Date() };

  if (updates.tags !== undefined) {
    data.tags = stringifyJson(updates.tags);
  }
  if (updates.extra_data !== undefined) {
    data.extraData = stringifyJson(updates.extra_data);
  }
  if (updates.folder_id !== undefined) {
    data.folderId = updates.folder_id;
  }

  const result = await prisma.assetItem.updateMany({
    where: { id: { in: ids } },
    data,
  });

  return { count: result.count };
}

export async function deleteAsset(id: number) {
  return prisma.assetItem.delete({ where: { id } });
}

export async function listSourceUrls(userId: number, spaceKey = "personal") {
  const items = await prisma.assetItem.findMany({
    where: { userId, spaceKey },
    select: { extraData: true },
    orderBy: { createdAt: "desc" },
  });

  const urls = new Set<string>();
  for (const item of items) {
    const extra = parseJsonObject(item.extraData);
    if (extra.source_url && typeof extra.source_url === "string") {
      urls.add(extra.source_url);
    }
  }

  return [...urls];
}
