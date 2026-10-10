/**
 * 文件引用账本。
 * file_refs 是引用事实来源；file_objects.ref_count 只保存按账本计算的聚合结果。
 * 所有写操作都要求传入 Prisma 事务客户端，确保业务数据、账本与聚合计数同生共死。
 */
import { Prisma } from "@prisma/client";
import { adjustFileRefCount } from "@server/crud/file";

/** 支持的业务来源类型。canvas_cover 是项目封面专用来源：与画布内容（canvas）
 *  正交——画布保存的 replaceSourceFileRefs 每次整替集合，封面若混入会被冲掉。 */
export type FileRefSourceType = "canvas" | "canvas_cover" | "asset_item";

/** 文件引用数量表：key 是内容 SHA256，value 是节点/条目数量。 */
export type FileHashCounts = Map<string, number>;

/** 文件引用来源定位信息。 */
export interface FileRefSource {
  userId: number;
  sourceType: FileRefSourceType;
  sourceId: string;
}

/** SQLite 的绑定参数数量有限；按来源 ID 分批回收。5 万来源回归测试（10 个分片）覆盖该分片大小。 */
const FILE_REF_SOURCE_CHUNK_SIZE = 5_000;

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
 * 与批量移除共用同一实现，保证"移除来源引用"只有一套规则。
 */
export async function removeSourceFileRefs(
  tx: Prisma.TransactionClient,
  source: FileRefSource,
): Promise<void> {
  await removeSourceFileRefsBatch(tx, {
    userId: source.userId,
    sourceType: source.sourceType,
    sourceIds: [source.sourceId],
  });
}

/**
 * 批量移除同一类型下的多个来源引用。
 * 引用回收用集合运算：先按 hash 聚合各来源的引用总量并一次递减聚合计数，再删除账本行。
 * 万级来源下逐 hash 循环会触发 Prisma 交互式事务 5s 默认超时（实测 5 万资产 P2028）；
 * 集合运算实测 <1s。IN 列表按 FILE_REF_SOURCE_CHUNK_SIZE 分片；各分片来源互不相交，
 * 同一 hash 的递减按片累加，因此每片可"先递减再删账本行"。
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

  for (let index = 0; index < params.sourceIds.length; index += FILE_REF_SOURCE_CHUNK_SIZE) {
    const sourceIds = params.sourceIds.slice(index, index + FILE_REF_SOURCE_CHUNK_SIZE);
    // UPDATE ... FROM 天然跳过缺失的 file_objects 行（与逐行实现的 P2025 吞掉语义一致）
    await tx.$executeRaw`
      UPDATE file_objects SET ref_count = ref_count - agg.cnt
      FROM (
        SELECT hash, SUM("count") AS cnt FROM file_refs
        WHERE user_id = ${params.userId} AND source_type = ${params.sourceType}
          AND source_id IN (${Prisma.join(sourceIds)})
        GROUP BY hash
      ) AS agg
      WHERE file_objects.user_id = ${params.userId} AND file_objects.hash = agg.hash`;
    await tx.$executeRaw`
      DELETE FROM file_refs
      WHERE user_id = ${params.userId} AND source_type = ${params.sourceType}
        AND source_id IN (${Prisma.join(sourceIds)})`;
  }
}
