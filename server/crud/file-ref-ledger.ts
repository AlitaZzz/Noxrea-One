/**
 * 文件引用账本。
 * file_refs 是引用事实来源；file_objects.ref_count 只保存按账本计算的聚合结果。
 * 所有写操作都要求传入 Prisma 事务客户端，确保业务数据、账本与聚合计数同生共死。
 */
import { Prisma } from "@server/core/database/generated/client";
import type { DbTx } from "@server/core/database/transaction";
import { hashFromStorageKey } from "@noxrea/shared/url";
import type { FileHashCounts, FileRefSource, FileRefSourceType } from "@server/schemas/file-ref";
import { adjustFileRefCountTx } from "./file";
import { lockUserWriteTx } from "./user-write-lock";

/** 按来源 ID 分批回收，避免单条语句参数过多、锁范围过大；5 万来源回归测试（10 个分片）覆盖该分片大小。 */
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
export async function replaceSourceFileRefsTx(
  tx: DbTx,
  source: FileRefSource,
  counts: FileHashCounts,
): Promise<void> {
  // 账本写会改动 file_refs / file_objects，与资产写共享行资源；画布、头像等
  // 非资产入口经此处获取同一用户锁（specs/asset-write-serialization.md R4）。
  // 资产路径的入口事务已持锁，pg_advisory_xact_lock 可重入。
  await lockUserWriteTx(tx, source.userId);
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

    await adjustFileRefCountTx(tx, source.userId, hash, delta);

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
 * 单值引用整替：单引用来源（资产 fileKey、画布封面、用户头像）共用的登记形状。
 * 调用方先完成各自值域校验（fail-closed，错误类型随来源），此处按 key-form 派生
 * 期望集整替：key → {hash:1}；null 或外部 URL（不入账本，既有语义）→ 清空该来源。
 */
export async function replaceSourceFileRefTx(
  tx: DbTx,
  source: FileRefSource,
  value: string | null,
): Promise<void> {
  const hash = value === null ? null : hashFromStorageKey(value);
  await replaceSourceFileRefsTx(tx, source, hash ? new Map([[hash, 1]]) : new Map());
}

/**
 * 移除一个业务来源的全部引用。
 * 常用于画布删除或资产条目删除，避免级联删除绕过聚合计数。
 * 与批量移除共用同一实现，保证"移除来源引用"只有一套规则。
 */
export async function removeSourceFileRefsTx(
  tx: DbTx,
  source: FileRefSource,
): Promise<void> {
  await removeSourceFileRefsBatchTx(tx, {
    userId: source.userId,
    sourceType: source.sourceType,
    sourceIds: [source.sourceId],
  });
}

/**
 * 批量移除同一类型下的多个来源引用。
 * 引用回收用集合运算：先按 hash 聚合各来源的引用总量并一次递减聚合计数，再删除账本行。
 * 万级来源下逐 hash 循环会触发 Prisma 交互式事务 5s 默认超时（实测 5 万资产 P2028）；
 * 集合运算实测 <1s。IN 列表按 FILE_REF_SOURCE_CHUNK_SIZE 分片，每片先递减聚合再删账本行：
 * 同一 hash 的递减按片累加；sourceIds 含重复 id 时，后一片已无行可匹配，不会重复递减。
 */
export async function removeSourceFileRefsBatchTx(
  tx: DbTx,
  params: {
    userId: number;
    sourceType: FileRefSourceType;
    sourceIds: string[];
  },
): Promise<void> {
  if (params.sourceIds.length === 0) return;

  // 同上：先取用户锁再改动共享账本行，保证与资产写、其它来源写串行。
  await lockUserWriteTx(tx, params.userId);

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
