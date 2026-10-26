/**
 * 资产与文件夹 CRUD。
 * 每个用户拥有一个资产库，「未分类」是固定的系统文件夹；
 * 资产变更与文件夹计数在同一事务内执行，保证数据与计数一致。
 */
import { Prisma, type AssetItem as AssetItemModel } from "@server/core/database/generated/client";
import { prisma } from "@server/core/database/client";
import { ASSET_FOLDERS_UNCATEGORIZED_KEY } from "@server/core/database/constraint-names";
import { isUniqueConstraintViolation } from "@server/core/database/errors";
import { hashFromStorageKey, isFileRefValue } from "@noxrea/shared/url";
import {
  replaceSourceFileRef,
  removeSourceFileRefsBatch,
} from "@server/services/storage/file-ref-ledger";
import { stringifyJson, parseJsonArray } from "./json-column";

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
      | "duplicate_file_key"
      | "invalid_file_key"
      | "uncategorized_folder_protected"
  ) {
    super(code);
  }
}

/**
 * 资产行删除的账本不变量（唯一实现）：先清引用账本（账本层按 hash 聚合递减
 * file_objects 计数，缺失的聚合行不阻塞删除），再删行，并按目录聚合递减直属计数。
 * deleteAsset / deleteAssetsBatch / deleteAssetsByFileKeys 与 key 化迁移脚本共用，
 * 保证「资产删除同步账本」只有一套规则。
 */
/** deleteAssetItemsTx 所需的资产条目最小字段集：账本清理与目录计数递减的定位键 */
export interface AssetItemLedgerRef {
  id: number;
  userId: number;
  folderId: number;
}

export async function deleteAssetItemsTx(
  tx: TransactionClient,
  rows: Array<AssetItemLedgerRef>,
): Promise<void> {
  if (rows.length === 0) return;
  const byUser = new Map<number, string[]>();
  for (const row of rows) {
    byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), String(row.id)]);
  }
  for (const [userId, sourceIds] of byUser) {
    await removeSourceFileRefsBatch(tx, { userId, sourceType: "asset_item", sourceIds });
  }
  await tx.assetItem.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  // 同一直属目录被删多条时聚合成一次递减，避免逐条 update
  const folderCounts = new Map<number, number>();
  for (const row of rows) {
    folderCounts.set(row.folderId, (folderCounts.get(row.folderId) ?? 0) + 1);
  }
  for (const [folderId, count] of folderCounts) {
    await tx.assetFolder.update({
      where: { id: folderId },
      data: { directCount: { decrement: count } },
    });
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
  fileKey: string;
  reason: AssetSkipReason;
}

/** 库内唯一性以 (scope, fileKey) 为键；用不可见分隔符拼接，避免引用值内容造成误判。 */
function identityKey(scope: string, fileKey: string): string {
  return `${scope}\u0000${fileKey}`;
}

/** 按 scope 分组查询库内已存在的来源引用，返回 (scope, fileKey) 键集合。 */
async function findExistingIdentityKeys(
  tx: TransactionClient,
  userId: number,
  items: Array<{ scope?: string; fileKey?: string | null }>
): Promise<Set<string>> {
  const keysByScope = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item.fileKey) continue;
    const scope = item.scope ?? "personal";
    const keys = keysByScope.get(scope) ?? new Set<string>();
    keys.add(item.fileKey);
    keysByScope.set(scope, keys);
  }

  const existingKeys = new Set<string>();
  for (const [scope, keys] of keysByScope) {
    const rows = await tx.assetItem.findMany({
      where: { userId, scope, fileKey: { in: [...keys] } },
      select: { fileKey: true },
    });
    for (const row of rows) {
      if (row.fileKey) existingKeys.add(identityKey(scope, row.fileKey));
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

/** 探测出的媒体元数据快照；拿不到的维度以 0 兜底（与前端「0 = 未知」口径一致） */
export interface AssetMediaMeta {
  size: number;
  width: number;
  height: number;
  /** 时长（秒），仅视频 / 音频有值，缺省为 0 */
  duration: number;
}

/**
 * 批量取资产源文件的媒体元数据：从 fileKey 提取内容 hash，查 file_objects
 * （元数据由服务端落盘时统一探测入库）。返回 hash → 元数据映射，
 * 供各序列化出口经 withMediaMeta 附加 size / width / height / duration。
 */
async function mediaMetaMapFor(
  db: Pick<Prisma.TransactionClient, "fileObject">,
  userId: number,
  items: Array<{ fileKey?: string | null }>,
): Promise<Map<string, AssetMediaMeta>> {
  const hashes = new Set<string>();
  for (const item of items) {
    const hash = item.fileKey ? hashFromStorageKey(item.fileKey) : null;
    if (hash) hashes.add(hash);
  }
  if (hashes.size === 0) return new Map();
  const rows = await db.fileObject.findMany({
    where: { userId, hash: { in: [...hashes] } },
    select: { hash: true, size: true, width: true, height: true, duration: true },
  });
  return new Map(rows.map((row) => [row.hash, {
    size: Number(row.size),
    width: row.width ?? 0,
    height: row.height ?? 0,
    duration: row.duration ?? 0,
  }]));
}

/**
 * 附加媒体元数据（源文件字节数与宽高时长；无 hash 或无对应文件记录时为 0）。
 *
 * 不预派生访问 URL：读路径由浏览器向描述接口换取签名直连地址（
 * specs/storage-signed-direct-delivery.md），DTO 只携带持久化值域的 `fileKey`
 * （与 `toPublicUser` 不再下发 `avatarUrl` 同一规则）。
 */
function withMediaMeta<T extends { fileKey?: string | null }>(
  item: T,
  metas: Map<string, AssetMediaMeta>,
): T & AssetMediaMeta {
  const hash = item.fileKey ? hashFromStorageKey(item.fileKey) : null;
  const meta = hash ? metas.get(hash) : undefined;
  return {
    ...item,
    size: meta?.size ?? 0,
    width: meta?.width ?? 0,
    height: meta?.height ?? 0,
    duration: meta?.duration ?? 0,
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
    // 并发首访撞部分唯一索引（asset_folders_uncategorized_key，迁移 20261015213000）：
    // 回读并发事务已建好的「未分类」目录
    if (!isUniqueConstraintViolation(error, ASSET_FOLDERS_UNCATEGORIZED_KEY)) throw error;

    const raced = await tx.assetFolder.findFirst({
      where: { userId, scope, kind: "uncategorized" },
    });
    if (!raced) throw error;
    return raced;
  }
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
    const subtreeIds = collectSubtreeIds(id, folders);

    const deletedAssets = await tx.assetItem.findMany({
      where: { userId, folderId: { in: subtreeIds } },
      select: { id: true, fileKey: true },
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
      fileKeys: deletedAssets
        .map((asset) => asset.fileKey)
        .filter((fileKey): fileKey is string => Boolean(fileKey)),
      counters: await readCounters(tx, userId, root.scope),
    };
  });
}

// Items

/** 资产列表游标：`<createdAt 毫秒>_<id>`。
 * 排序固定为 createdAt desc, id desc，游标指向「上一页最后一条」，
 * 取下一行严格更旧的记录。keyset 分页在新增/删除后不会像 offset 那样漂移、重复或漏项。
 * 导出供测试锁定游标契约。 */
export function parseAssetCursor(raw: string): { createdAt: Date; id: number } | null {
  const match = /^(\d+)_(\d+)$/.exec(raw);
  if (!match) return null;
  return { createdAt: new Date(Number(match[1])), id: Number(match[2]) };
}

export function encodeAssetCursor(row: { createdAt: Date; id: number }): string {
  return `${row.createdAt.getTime()}_${row.id}`;
}

/** 展开某文件夹的完整子树 id（含自身）；folders 为同一 scope 下全部文件夹的 id/parentId 列表。
 * 导出供测试锁定子树展开语义。 */
export function collectSubtreeIds(rootId: number, folders: { id: number; parentId: number | null }[]): number[] {
  const childrenByParent = new Map<number | null, number[]>();
  for (const folder of folders) {
    const parentId = folder.parentId ?? null;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(folder.id);
    childrenByParent.set(parentId, children);
  }
  const ids: number[] = [];
  const stack = [rootId];
  while (stack.length) {
    const current = stack.pop()!;
    if (ids.includes(current)) continue;
    ids.push(current);
    for (const childId of childrenByParent.get(current) ?? []) stack.push(childId);
  }
  return ids;
}

export async function getAssets(params: {
  userId: number;
  folderId?: number;
  type?: string;
  search?: string;
  scope?: string;
  cursor?: string;
  limit?: number;
}) {
  const scope = params.scope ?? "personal";
  let folderWhere: Prisma.AssetItemWhereInput | undefined;
  if (params.folderId !== undefined) {
    await requireFolder(prisma, params.userId, params.folderId, scope);
    if (params.search?.trim()) {
      // 文件夹内搜索覆盖整棵子树：展开后代 id 后按 IN 过滤（浏览态仍只看直属资产）
      const folderRows = await prisma.assetFolder.findMany({
        where: { userId: params.userId, scope },
        select: { id: true, parentId: true },
      });
      folderWhere = { folderId: { in: collectSubtreeIds(params.folderId, folderRows) } };
    } else {
      folderWhere = { folderId: params.folderId };
    }
  }

  const typeList = params.type
    ? params.type.split(",").map((type) => type.trim()).filter(Boolean)
    : [];
  const search = params.search?.trim();

  // 基础过滤（列表与 count 共用，保证 total 与筛选条件一致）；游标条件只加给列表查询。
  const baseWhere: Prisma.AssetItemWhereInput = {
    userId: params.userId,
    scope,
    ...(folderWhere ?? {}),
  };
  const baseAnd: Prisma.AssetItemWhereInput[] = [];
  if (typeList.length) baseAnd.push({ type: { in: typeList } });
  if (search) baseAnd.push({ name: { contains: search } });
  if (baseAnd.length) baseWhere.AND = baseAnd;

  const cursor = params.cursor ? parseAssetCursor(params.cursor) : null;
  const listWhere: Prisma.AssetItemWhereInput = cursor
    ? {
        ...baseWhere,
        AND: [
          ...baseAnd,
          // 严格落在游标之后（更旧）：createdAt 更小，或 createdAt 相同但 id 更小。
          {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          },
        ],
      }
    : baseWhere;

  const take = Math.min(params.limit ?? 20, 200);
  // 多取一条用于判断是否还有下一页，并据此生成下一游标。
  const [rows, total] = await Promise.all([
    prisma.assetItem.findMany({
      where: listWhere,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
    }),
    prisma.assetItem.count({ where: baseWhere }),
  ]);

  const hasMore = rows.length > take;
  const page = rows.slice(0, take);
  const nextCursor = hasMore && page.length > 0 ? encodeAssetCursor(page[page.length - 1]) : null;
  const metas = await mediaMetaMapFor(prisma, params.userId, page);

  return { items: page.map((row) => withMediaMeta(deserializeAsset(row), metas)), total, nextCursor };
}

export async function getAsset(userId: number, id: number) {
  const item = await prisma.assetItem.findFirst({ where: { id, userId } });
  if (!item) return null;
  const metas = await mediaMetaMapFor(prisma, userId, [item]);
  return withMediaMeta(deserializeAsset(item), metas);
}

export async function createAssetsBatch(
  items: Array<{
    userId: number;
    name?: string;
    type?: string;
    mediaType?: string;
    fileKey?: string | null;
    sourceType?: string;
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

  // 去重不再整批失败：批内重复保留首条，库内已存在直接跳过，其余资产照常入库。
  // 来源引用（key 或外部 URL）精确保存即可去重；不额外落一列哈希。（纯内存去重，放事务外）
  const skipped: SkippedAssetSource[] = [];
  const seenKeys = new Set<string>();
  const candidates: typeof items = [];
  for (const item of items) {
    const scope = item.scope ?? "personal";
    const fileKey = item.fileKey ?? null;
    if (fileKey) {
      const key = identityKey(scope, fileKey);
      if (seenKeys.has(key)) {
        skipped.push({ fileKey, reason: "duplicate_in_batch" });
        continue;
      }
      seenKeys.add(key);
    }
    candidates.push(item);
  }

  return prisma.$transaction(async (tx) => {
    const created: SerializedAssetItem[] = [];
    const uncategorizedByScope = new Map<string, number>();

    // 按 scope 分组查库内已存在来源；命中项跳过，不阻塞同批其他资产。
    const existingKeys = await findExistingIdentityKeys(tx, items[0].userId, candidates);
    const pending = candidates.filter((item) => {
      if (!item.fileKey) return true;
      const key = identityKey(item.scope ?? "personal", item.fileKey);
      if (!existingKeys.has(key)) return true;
      skipped.push({ fileKey: item.fileKey, reason: "already_exists" });
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
          description: item.description ?? "",
          tags: stringifyJson(item.tags ?? []),
          prompt: item.prompt ?? "",
          folderId,
          scope,
          fileKey: item.fileKey ?? null,
          sourceType: item.sourceType ?? "",
        },
      });
      created.push(deserializeAsset(record));
      await tx.assetFolder.update({
        where: { id: folderId },
        data: { directCount: { increment: 1 } },
      });

      // 资产创建与引用登记必须在同一事务内，避免出现已入库但未计数的资产。
      // 入库值域 = 存储 key 或外部 URL（schema 层已校验）：key 登记账本防 GC 误回收，
      // 外部 URL 不入账本（既有语义）；其余形态 fail-closed 拒绝，不允许静默丢账本。
      if (record.fileKey) {
        if (!isFileRefValue(record.fileKey)) {
          throw new AssetOperationError("invalid_file_key");
        }
        await replaceSourceFileRef(tx, {
          userId: item.userId,
          sourceType: "asset_item",
          sourceId: String(record.id),
        }, record.fileKey);
      }
    }

    const createdMetas = await mediaMetaMapFor(tx, items[0].userId, created);
    return {
      items: created.map((item) => withMediaMeta(item, createdMetas)),
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
      item: withMediaMeta(deserializeAsset(updated), await mediaMetaMapFor(tx, userId, [updated])),
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

    // 资产删除统一走 deleteAssetItemsTx：清账本 → 删行 → 目录计数聚合递减
    await deleteAssetItemsTx(tx, [{ id: current.id, userId, folderId: current.folderId }]);

    return {
      item: withMediaMeta(deserializeAsset(current), await mediaMetaMapFor(tx, userId, [current])),
      counters: await readCounters(tx, userId, current.scope),
    };
  });
}

export async function deleteAssetsBatch(userId: number, ids: number[]) {
  return prisma.$transaction(async (tx) => {
    const currentItems = await tx.assetItem.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true, folderId: true, scope: true, fileKey: true },
    });
    if (currentItems.length !== new Set(ids).size) throw new AssetOperationError("asset_not_found");

    const scopes = [...new Set(currentItems.map((item) => item.scope))];
    if (scopes.length > 1) throw new AssetOperationError("asset_not_found");
    const scope = scopes[0] ?? "personal";

    await deleteAssetItemsTx(tx, currentItems.map((item) => ({ id: item.id, userId, folderId: item.folderId })));

    return {
      count: currentItems.length,
      fileKeys: currentItems
        .map((item) => item.fileKey)
        .filter((fileKey): fileKey is string => Boolean(fileKey)),
      counters: await readCounters(tx, userId, scope),
    };
  });
}

/**
 * 按 fileKey 删除资产（画布节点「收藏 / 取消收藏」切换用）。
 * 仅删个人库中 URL 精确匹配的条目（画布收藏只写个人库）；
 * 宽松语义：无匹配条目也算成功（count = 0），方便前端幂等取消。
 */
export async function deleteAssetsByFileKeys(userId: number, fileKeys: string[]) {
  return prisma.$transaction(async (tx) => {
    const currentItems = await tx.assetItem.findMany({
      where: { userId, scope: "personal", fileKey: { in: fileKeys } },
      select: { id: true, folderId: true, scope: true, fileKey: true },
    });
    if (currentItems.length === 0) {
      return { count: 0, fileKeys: [], counters: await readCounters(tx, userId, "personal") };
    }

    await deleteAssetItemsTx(tx, currentItems.map((item) => ({ id: item.id, userId, folderId: item.folderId })));

    return {
      count: currentItems.length,
      fileKeys: currentItems
        .map((item) => item.fileKey)
        .filter((fileKey): fileKey is string => Boolean(fileKey)),
      counters: await readCounters(tx, userId, "personal"),
    };
  });
}

export async function listFileKeys(userId: number, scope = "personal") {
  const items = await prisma.assetItem.findMany({
    where: { userId, scope, fileKey: { not: null } },
    select: { fileKey: true },
  });
  return [...new Set(items.map((item) => item.fileKey).filter((key): key is string => Boolean(key)))];
}

/** 初始化资产库：固定目录、来源集合和总数一次返回。 */
export async function getAssetLibrarySummary(userId: number, scope = "personal") {
  if (scope === "personal") {
    await prisma.$transaction(async (tx) => {
      await getOrCreateUncategorizedFolder(tx, userId, scope);
    });
  }
  const folders = await getFolders(userId, scope);
  const fileKeys = await listFileKeys(userId, scope);
  const totalCount = folders.reduce((total, folder) => total + folder.count, 0);
  return { folders, fileKeys, totalCount };
}
