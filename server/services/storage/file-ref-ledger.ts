/**
 * 文件引用账本。
 * file_refs 是引用事实来源；file_objects.ref_count 只保存按账本计算的聚合结果。
 * 所有写操作都要求传入 Prisma 事务客户端，确保业务数据、账本与聚合计数同生共死。
 */
import type { Prisma } from "@prisma/client";
import { adjustFileRefCount } from "@server/crud/file";

/** 支持的业务来源类型。 */
export type FileRefSourceType = "canvas" | "asset_item";

/** 文件引用数量表：key 是内容 SHA256，value 是节点/条目数量。 */
export type FileHashCounts = Map<string, number>;

/** 文件引用来源定位信息。 */
export interface FileRefSource {
  userId: number;
  sourceType: FileRefSourceType;
  sourceId: string;
}

/** SQLite 的绑定参数数量有限；按来源 ID 分批查询/删除，避免目录资产过多时失败。 */
const FILE_REF_SOURCE_CHUNK_SIZE = 500;

/** 规整期望引用：过滤空数量，并确保数量至少为 1。 */
function normalizeCounts(counts: FileHashCounts): FileHashCounts {
  const normalized: FileHashCounts = new Map();
  for (const [hash, count] of counts) {
    if (!hash || count <= 0) continue;
    normalized.set(hash, count);
  }
  return normalized;
}

/**
 * 将一个业务来源的引用集合替换为期望值。
 * 内部先读取账本旧值，再按 hash 数量差值增减聚合计数，最后更新或删除账本行。
 */
export async function replaceSourceFileRefs(
  tx: Prisma.TransactionClient,
  source: FileRefSource,
  counts: FileHashCounts,
): Promise<void> {
  const desired = normalizeCounts(counts);
  const oldRows = await tx.fileRef.findMany({
    where: {
      userId: source.userId,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
    },
    select: { id: true, hash: true, count: true },
  });
  const oldCounts = new Map(oldRows.map((row) => [row.hash, row.count]));
  const hashes = new Set([...oldCounts.keys(), ...desired.keys()]);

  for (const hash of hashes) {
    const oldCount = oldCounts.get(hash) ?? 0;
    const newCount = desired.get(hash) ?? 0;
    const delta = newCount - oldCount;
    if (delta === 0) continue;

    await adjustFileRefCount(tx, source.userId, hash, delta);

    if (newCount === 0) {
      await tx.fileRef.deleteMany({
        where: {
          userId: source.userId,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          hash,
        },
      });
      continue;
    }

    await tx.fileRef.upsert({
      where: {
        sourceType_sourceId_hash: {
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          hash,
        },
      },
      update: { count: newCount },
      create: {
        userId: source.userId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        hash,
        count: newCount,
      },
    });
  }
}

/**
 * 移除一个业务来源的全部引用。
 * 常用于画布删除或资产条目删除，避免级联删除绕过聚合计数。
 */
export async function removeSourceFileRefs(
  tx: Prisma.TransactionClient,
  source: FileRefSource,
): Promise<void> {
  const rows = await tx.fileRef.findMany({
    where: {
      userId: source.userId,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
    },
    select: { hash: true, count: true },
  });

  for (const row of rows) {
    await adjustFileRefCount(tx, source.userId, row.hash, -row.count);
  }

  await tx.fileRef.deleteMany({
    where: {
      userId: source.userId,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
    },
  });
}

/**
 * 批量移除同一类型下的多个来源引用。
 * 目录删除可能包含大量资产，一次读取账本并按 hash 合并递减，减少数据库往返。
 */
export async function removeSourceFileRefsBatch(
  tx: Prisma.TransactionClient,
  params: {
    userId: number;
    sourceType: FileRefSourceType;
    sourceIds: string[];
  },
): Promise<void> {
  if (params.sourceIds.length === 0) return;

  const rows: Array<{ hash: string; count: number }> = [];
  for (let index = 0; index < params.sourceIds.length; index += FILE_REF_SOURCE_CHUNK_SIZE) {
    const sourceIds = params.sourceIds.slice(index, index + FILE_REF_SOURCE_CHUNK_SIZE);
    const chunkRows = await tx.fileRef.findMany({
      where: {
        userId: params.userId,
        sourceType: params.sourceType,
        sourceId: { in: sourceIds },
      },
      select: { hash: true, count: true },
    });
    rows.push(...chunkRows);
  }

  const deltas = new Map<string, number>();
  for (const row of rows) {
    deltas.set(row.hash, (deltas.get(row.hash) ?? 0) + row.count);
  }

  for (const [hash, count] of deltas) {
    await adjustFileRefCount(tx, params.userId, hash, -count);
  }

  for (let index = 0; index < params.sourceIds.length; index += FILE_REF_SOURCE_CHUNK_SIZE) {
    await tx.fileRef.deleteMany({
      where: {
        userId: params.userId,
        sourceType: params.sourceType,
        sourceId: { in: params.sourceIds.slice(index, index + FILE_REF_SOURCE_CHUNK_SIZE) },
      },
    });
  }
}
