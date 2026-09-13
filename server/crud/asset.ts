/**
 * 资产与文件夹 CRUD。
 * 每个用户拥有一个资产库，「未分类」是固定的系统文件夹；
 * 资产变更与文件夹计数在同一事务内执行，保证数据与计数一致。
 */
import { Prisma, type AssetItem as AssetItemModel } from "@prisma/client";
import { prisma } from "@server/core/database/client";
import { extractHashFromUrl } from "@server/utils/extract-hashes";
import {
  replaceSourceFileRefs,
  removeSourceFileRefsBatch,
} from "@server/services/storage/file-ref-ledger";
import { stringifyJson, parseJsonArray } from "./_json";

type TransactionClient = Prisma.TransactionClient;

/** Prisma 资产记录反序列化后的返回结构。 */
type SerializedAssetItem = Omit<AssetItemModel, "tags"> & {
  tags: string[];
};

/** 业务冲突错误，路由层转换为统一错误码。 */
export class AssetOperationError extends Error {
  constructor(
    readonly code:
      | "folder_not_found"
      | "asset_not_found"
      | "duplicate_source_url"
      | "uncategorized_folder_protected"
  ) {
    super(code);
  }
}

/** 写操作返回的文件夹计数快照；回传全量当前库目录计数，避免前端手工加减。 */
export interface AssetCounters {
  folders: Record<string, number>;
  total: number;
}

/** 批量创建时来源重复被跳过的原因。 */
export type AssetSkipReason = "already_exists" | "duplicate_in_batch";

/** 批量创建中被跳过的资产来源；重复属于正常结果，不再让整批失败。 */
export interface SkippedAssetSource {
  sourceUrl: string;
  reason: AssetSkipReason;
}

/** 库内唯一性以 (scope, sourceUrl) 为键；用不可见分隔符拼接，避免 URL 内容造成误判。 */
function sourceKey(scope: string, sourceUrl: string): string {
  return `${scope}\u0000${sourceUrl}`;
}

/** 按 scope 分组查询库内已存在的来源 URL，返回 (scope, sourceUrl) 键集合。 */
async function findExistingSourceKeys(
  tx: TransactionClient,
  userId: number,
  items: Array<{ scope?: string; sourceUrl?: string | null }>
): Promise<Set<string>> {
  const urlsByScope = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item.sourceUrl) continue;
    const scope = item.scope ?? "personal";
    const urls = urlsByScope.get(scope) ?? new Set<string>();
    urls.add(item.sourceUrl);
    urlsByScope.set(scope, urls);
  }

  const existingKeys = new Set<string>();
  for (const [scope, urls] of urlsByScope) {
    const rows = await tx.assetItem.findMany({
      where: { userId, scope, sourceUrl: { in: [...urls] } },
      select: { sourceUrl: true },
    });
    for (const row of rows) {
      if (row.sourceUrl) existingKeys.add(sourceKey(scope, row.sourceUrl));
    }
  }
  return existingKeys;
}

function deserializeAsset<T extends { tags: unknown }>(item: T) {
  return {
    ...item,
    tags: parseJsonArray(item.tags),
  };
}

/** 获取（必要时创建）当前用户当前 scope 的固定「未分类」目录。 */
async function getOrCreateUncategorizedFolder(
  tx: TransactionClient,
  userId: number,
  scope = "personal"
) {
  const existing = await tx.assetFolder.findFirst({
    where: { userId, scope, kind: "uncategorized" },
  });
  if (existing) return existing;

  try {
    return await tx.assetFolder.create({
      data: { userId, scope, name: "Uncategorized", kind: "uncategorized", parentId: null },
    });
  } catch (error) {
    if (!isUncategorizedFolderUniqueError(error)) throw error;

    const raced = await tx.assetFolder.findFirst({
      where: { userId, scope, kind: "uncategorized" },
    });
    if (!raced) throw error;
    return raced;
  }
}

/** 判断唯一约束冲突是否来自「未分类」目录的固定索引。 */
function isUncategorizedFolderUniqueError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  const targetText = Array.isArray(target) ? target.join(":") : String(target ?? "");
  return targetText.includes("uncategorized");
}

/** 校验目录归属与 scope，避免任意目录 ID 越权或跨库移动。 */
async function requireFolder(
  tx: TransactionClient,
  userId: number,
  folderId: number,
  scope = "personal"
) {
  const folder = await tx.assetFolder.findFirst({
    where: { id: folderId, userId, scope },
  });
  if (!folder) throw new AssetOperationError("folder_not_found");
  return folder;
}

/** 读取当前用户当前 scope 的全部目录计数；资产总数由所有目录直属计数求和得出。 */
async function readCounters(
  tx: TransactionClient,
  userId: number,
  scope = "personal"
): Promise<AssetCounters> {
  const folders = await tx.assetFolder.findMany({
    where: { userId, scope },
    select: { id: true, directCount: true },
  });

  return {
    folders: Object.fromEntries(folders.map((folder) => [String(folder.id), folder.directCount])),
    total: folders.reduce((total, folder) => total + folder.directCount, 0),
  };
}

function serializeFolder(folder: { directCount: number } & Record<string, unknown>) {
  return {
    ...folder,
    count: folder.directCount,
  };
}

// Folders

export async function getFolders(userId: number, scope = "personal") {
  const folders = await prisma.assetFolder.findMany({
    where: { userId, scope },
    orderBy: [{ kind: "asc" }, { createdAt: "desc" }],
  });
  return folders.map(serializeFolder);
}

export async function getFolder(userId: number, id: number) {
  const folder = await prisma.assetFolder.findFirst({ where: { id, userId } });
  return folder ? serializeFolder(folder) : null;
}

export async function createFolder(
  userId: number,
  data: { name: string; scope?: string; parentId?: number | null }
) {
  const scope = data.scope ?? "personal";
  return prisma.$transaction(async (tx) => {
    await getOrCreateUncategorizedFolder(tx, userId, scope);

    if (data.parentId != null) {
      const parentFolder = await requireFolder(tx, userId, data.parentId, scope);
      if (parentFolder.kind === "uncategorized") {
        throw new AssetOperationError("uncategorized_folder_protected");
      }
    }

    const folder = await tx.assetFolder.create({
      data: {
        userId,
        name: data.name,
        scope,
        kind: "normal",
        parentId: data.parentId ?? null,
      },
    });
    return serializeFolder(folder);
  });
}

export async function updateFolder(userId: number, id: number, name: string) {
  return prisma.$transaction(async (tx) => {
    const folder = await tx.assetFolder.findFirst({ where: { id, userId } });
    if (!folder) throw new AssetOperationError("folder_not_found");
    if (folder.kind === "uncategorized") {
      throw new AssetOperationError("uncategorized_folder_protected");
    }

    const updated = await tx.assetFolder.update({
      where: { id },
      data: { name },
    });
    return serializeFolder(updated);
  });
}

export async function deleteFolder(userId: number, id: number) {
  return prisma.$transaction(async (tx) => {
    const root = await tx.assetFolder.findFirst({ where: { id, userId } });
    if (!root) throw new AssetOperationError("folder_not_found");
    if (root.kind === "uncategorized") {
      throw new AssetOperationError("uncategorized_folder_protected");
    }

    // 先展开子树；分类删除时其直属资产也一并删除，不再迁移到「未分类」。
    const folders = await tx.assetFolder.findMany({
      where: { userId, scope: root.scope },
      select: { id: true, parentId: true },
    });
    const childrenByParent = new Map<number | null, number[]>();
    for (const folder of folders) {
      const parentId = folder.parentId ?? null;
      const children = childrenByParent.get(parentId) ?? [];
      children.push(folder.id);
      childrenByParent.set(parentId, children);
    }

    const subtreeIds: number[] = [];
    const stack = [id];
    while (stack.length) {
      const current = stack.pop()!;
      if (subtreeIds.includes(current)) continue;
      subtreeIds.push(current);
      for (const childId of childrenByParent.get(current) ?? []) stack.push(childId);
    }

    const deletedAssets = await tx.assetItem.findMany({
      where: { userId, folderId: { in: subtreeIds } },
      select: { id: true, sourceUrl: true },
    });
    // 子树内资产可能引用同一文件，账本层会合并数量后递减聚合计数。
    await removeSourceFileRefsBatch(tx, {
      userId,
      sourceType: "asset_item",
      sourceIds: deletedAssets.map((asset) => String(asset.id)),
    });
    await tx.assetItem.deleteMany({
      where: { userId, folderId: { in: subtreeIds } },
    });
    await tx.assetFolder.deleteMany({ where: { id: { in: subtreeIds }, userId } });

    return {
      removedCount: deletedAssets.length,
      sourceUrls: deletedAssets
        .map((asset) => asset.sourceUrl)
        .filter((sourceUrl): sourceUrl is string => Boolean(sourceUrl)),
      counters: await readCounters(tx, userId, root.scope),
    };
  });
}

// Items

export async function getAssets(params: {
  userId: number;
  folderId?: number;
  type?: string;
  search?: string;
  scope?: string;
  skip?: number;
  limit?: number;
}) {
  const scope = params.scope ?? "personal";
  if (params.folderId !== undefined) {
    await requireFolder(prisma, params.userId, params.folderId, scope);
  }

  const where: Prisma.AssetItemWhereInput = {
    userId: params.userId,
    scope,
  };
  if (params.folderId !== undefined) where.folderId = params.folderId;

  const typeList = params.type
    ? params.type.split(",").map((type) => type.trim()).filter(Boolean)
    : [];
  const search = params.search?.trim();
  if (typeList.length || search) {
    where.AND = [
      ...(typeList.length ? [{ type: { in: typeList } }] : []),
      ...(search ? [{ name: { contains: search } }] : []),
    ];
  }

  const [items, total] = await Promise.all([
    prisma.assetItem.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: params.skip ?? 0,
      take: Math.min(params.limit ?? 20, 200),
    }),
    prisma.assetItem.count({ where }),
  ]);

  return { items: items.map(deserializeAsset), total };
}

export async function getAsset(userId: number, id: number) {
  const item = await prisma.assetItem.findFirst({ where: { id, userId } });
  return item ? deserializeAsset(item) : null;
}

export async function createAssetsBatch(
  items: Array<{
    userId: number;
    name?: string;
    type?: string;
    mediaType?: string;
    sourceUrl?: string | null;
    sourceType?: string;
    width?: number;
    height?: number;
    description?: string;
    tags?: string[];
    prompt?: string;
    folderId?: number | null;
    scope?: string;
  }>
) {
  if (items.length === 0) {
    return {
      items: [],
      counters: { folders: {}, total: 0 } satisfies AssetCounters,
      skipped: [] as SkippedAssetSource[],
    };
  }

  return prisma.$transaction(async (tx) => {
    const created: SerializedAssetItem[] = [];
    const skipped: SkippedAssetSource[] = [];
    const uncategorizedByScope = new Map<string, number>();

    // 去重不再整批失败：批内重复保留首条，库内已存在直接跳过，其余资产照常入库。
    // 来源 URL 精确保存即可去重；不额外落一列哈希。
    const seenKeys = new Set<string>();
    const candidates: typeof items = [];
    for (const item of items) {
      const scope = item.scope ?? "personal";
      const sourceUrl = item.sourceUrl ?? null;
      if (sourceUrl) {
        const key = sourceKey(scope, sourceUrl);
        if (seenKeys.has(key)) {
          skipped.push({ sourceUrl, reason: "duplicate_in_batch" });
          continue;
        }
        seenKeys.add(key);
      }
      candidates.push(item);
    }

    // 按 scope 分组查库内已存在来源；命中项跳过，不阻塞同批其他资产。
    const existingKeys = await findExistingSourceKeys(tx, items[0].userId, candidates);
    const pending = candidates.filter((item) => {
      if (!item.sourceUrl) return true;
      const key = sourceKey(item.scope ?? "personal", item.sourceUrl);
      if (!existingKeys.has(key)) return true;
      skipped.push({ sourceUrl: item.sourceUrl, reason: "already_exists" });
      return false;
    });

    for (const item of pending) {
      const scope = item.scope ?? "personal";
      let folderId = item.folderId ?? null;
      if (folderId == null) {
        const cachedFolderId = uncategorizedByScope.get(scope);
        if (cachedFolderId) {
          folderId = cachedFolderId;
        } else {
          const folder = await getOrCreateUncategorizedFolder(tx, item.userId, scope);
          uncategorizedByScope.set(scope, folder.id);
          folderId = folder.id;
        }
      } else {
        const folder = await requireFolder(tx, item.userId, folderId, scope);
        if (folder.scope !== scope) throw new AssetOperationError("folder_not_found");
      }

      const record = await tx.assetItem.create({
        data: {
          userId: item.userId,
          name: item.name ?? "Untitled",
          type: item.type ?? "other",
          mediaType: item.mediaType ?? "",
          width: item.width ?? 0,
          height: item.height ?? 0,
          description: item.description ?? "",
          tags: stringifyJson(item.tags ?? []),
          prompt: item.prompt ?? "",
          folderId,
          scope,
          sourceUrl: item.sourceUrl ?? null,
          sourceType: item.sourceType ?? "",
        },
      });
      created.push(deserializeAsset(record));
      await tx.assetFolder.update({
        where: { id: folderId },
        data: { directCount: { increment: 1 } },
      });

      // 资产创建与引用登记必须在同一事务内，避免出现已入库但未计数的资产。
      const hash = record.sourceUrl ? extractHashFromUrl(record.sourceUrl) : null;
      if (hash) {
        await replaceSourceFileRefs(tx, {
          userId: item.userId,
          sourceType: "asset_item",
          sourceId: String(record.id),
        }, new Map([[hash, 1]]));
      }
    }

    return {
      items: created,
      counters: await readCounters(tx, items[0].userId, items[0].scope ?? "personal"),
      skipped,
    };
  });
}

export async function updateAsset(
  userId: number,
  id: number,
  updates: {
    name?: string;
    type?: string;
    width?: number;
    height?: number;
    description?: string;
    folderId?: number | null;
    tags?: string[];
    prompt?: string;
  }
) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.assetItem.findFirst({ where: { id, userId } });
    if (!current) throw new AssetOperationError("asset_not_found");

    const data: Prisma.AssetItemUpdateInput = { updatedAt: new Date() };
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.type !== undefined) data.type = updates.type;
    if (updates.width !== undefined) data.width = updates.width;
    if (updates.height !== undefined) data.height = updates.height;
    if (updates.description !== undefined) data.description = updates.description;
    if (updates.tags !== undefined) data.tags = stringifyJson(updates.tags);
    if (updates.prompt !== undefined) data.prompt = updates.prompt;

    let targetFolderId = current.folderId;
    if (updates.folderId !== undefined && updates.folderId !== current.folderId) {
      if (updates.folderId == null) {
        const folder = await getOrCreateUncategorizedFolder(tx, userId, current.scope);
        updates.folderId = folder.id;
      }
      const folder = await requireFolder(tx, userId, updates.folderId, current.scope);
      targetFolderId = folder.id;
      data.folder = { connect: { id: folder.id } };
    }

    const updated = await tx.assetItem.update({ where: { id }, data });
    if (targetFolderId !== current.folderId) {
      await tx.assetFolder.update({
        where: { id: current.folderId },
        data: { directCount: { decrement: 1 } },
      });
      await tx.assetFolder.update({
        where: { id: targetFolderId },
        data: { directCount: { increment: 1 } },
      });
    }

    return {
      item: deserializeAsset(updated),
      counters: await readCounters(tx, userId, current.scope),
    };
  });
}

export async function updateAssetsBatch(
  userId: number,
  ids: number[],
  updates: { folderId?: number | null; type?: string }
) {
  return prisma.$transaction(async (tx) => {
    const currentItems = await tx.assetItem.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true, folderId: true, scope: true },
    });
    if (currentItems.length !== new Set(ids).size) throw new AssetOperationError("asset_not_found");

    const data: Prisma.AssetItemUncheckedUpdateManyInput = { updatedAt: new Date() };
    if (updates.type !== undefined) data.type = updates.type;

    const scopes = [...new Set(currentItems.map((item) => item.scope))];
    if (updates.folderId !== undefined) {
      if (scopes.length > 1) throw new AssetOperationError("folder_not_found");

      const scope = scopes[0] ?? "personal";
      const targetFolder = updates.folderId == null
        ? await getOrCreateUncategorizedFolder(tx, userId, scope)
        : await requireFolder(tx, userId, updates.folderId, scope);

      const movedItems = currentItems.filter((item) => item.folderId !== targetFolder.id);
      const oldFolderCounts = new Map<number, number>();
      for (const item of movedItems) {
        oldFolderCounts.set(item.folderId, (oldFolderCounts.get(item.folderId) ?? 0) + 1);
      }

      data.folderId = targetFolder.id;
      await tx.assetItem.updateMany({ where: { id: { in: ids }, userId }, data });

      for (const [folderId, count] of oldFolderCounts) {
        await tx.assetFolder.update({
          where: { id: folderId },
          data: { directCount: { decrement: count } },
        });
      }
      await tx.assetFolder.update({
        where: { id: targetFolder.id },
        data: { directCount: { increment: movedItems.length } },
      });
    } else {
      await tx.assetItem.updateMany({ where: { id: { in: ids }, userId }, data });
    }

    return {
      count: currentItems.length,
      counters: await readCounters(tx, userId, scopes[0] ?? "personal"),
    };
  });
}

export async function deleteAsset(userId: number, id: number) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.assetItem.findFirst({ where: { id, userId } });
    if (!current) throw new AssetOperationError("asset_not_found");

    // 账本删除和聚合计数递减先执行；缺失的聚合行不会阻塞资产删除。
    await removeSourceFileRefsBatch(tx, {
      userId,
      sourceType: "asset_item",
      sourceIds: [String(current.id)],
    });
    await tx.assetItem.delete({ where: { id } });
    await tx.assetFolder.update({
      where: { id: current.folderId },
      data: { directCount: { decrement: 1 } },
    });

    return {
      item: deserializeAsset(current),
      counters: await readCounters(tx, userId, current.scope),
    };
  });
}

export async function deleteAssetsBatch(userId: number, ids: number[]) {
  return prisma.$transaction(async (tx) => {
    const currentItems = await tx.assetItem.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true, folderId: true, scope: true, sourceUrl: true },
    });
    if (currentItems.length !== new Set(ids).size) throw new AssetOperationError("asset_not_found");

    const scopes = [...new Set(currentItems.map((item) => item.scope))];
    if (scopes.length > 1) throw new AssetOperationError("asset_not_found");
    const scope = scopes[0] ?? "personal";

    await removeSourceFileRefsBatch(tx, {
      userId,
      sourceType: "asset_item",
      sourceIds: currentItems.map((item) => String(item.id)),
    });
    await tx.assetItem.deleteMany({ where: { id: { in: ids }, userId } });

    // 同一直属目录被删多条时聚合成一次递减，避免逐条 update。
    const folderCounts = new Map<number, number>();
    for (const item of currentItems) {
      folderCounts.set(item.folderId, (folderCounts.get(item.folderId) ?? 0) + 1);
    }
    for (const [folderId, count] of folderCounts) {
      await tx.assetFolder.update({
        where: { id: folderId },
        data: { directCount: { decrement: count } },
      });
    }

    return {
      count: currentItems.length,
      sourceUrls: currentItems
        .map((item) => item.sourceUrl)
        .filter((sourceUrl): sourceUrl is string => Boolean(sourceUrl)),
      counters: await readCounters(tx, userId, scope),
    };
  });
}

export async function listSourceUrls(userId: number, scope = "personal") {
  const items = await prisma.assetItem.findMany({
    where: { userId, scope, sourceUrl: { not: null } },
    select: { sourceUrl: true },
  });
  return [...new Set(items.map((item) => item.sourceUrl).filter((url): url is string => Boolean(url)))];
}

/** 初始化资产库：固定目录、来源集合和总数一次返回。 */
export async function getAssetLibrarySummary(userId: number, scope = "personal") {
  if (scope === "personal") {
    await prisma.$transaction(async (tx) => {
      await getOrCreateUncategorizedFolder(tx, userId, scope);
    });
  }
  const folders = await getFolders(userId, scope);
  const sourceUrls = await listSourceUrls(userId, scope);
  const totalCount = folders.reduce((total, folder) => total + folder.count, 0);
  return { folders, sourceUrls, totalCount };
}
