/**
 * 文件引用管理服务。
 * 基于 FileObject.refCount 的原子增减实现引用追踪与孤儿文件 GC。
 */
import { incrementRefCount, decrementRefCount } from "@server/crud/file";
import { localStorage } from "./backends/local";
import { buildStorageKey } from "./service";
import { extractHashFromUrl } from "@server/utils/extract-hashes";
import { logger } from "@server/core/logger";

/** 从资产 extraData 中提取文件 hash */
export function extractHashFromAsset(extraData: Record<string, unknown>): string | null {
  const sourceUrl = extraData?.sourceUrl;
  if (typeof sourceUrl !== "string") return null;
  return extractHashFromUrl(sourceUrl);
}

/** 删除物理文件 */
async function deletePhysicalFile(userId: number, hash: string, ext: string): Promise<void> {
  const storageKey = buildStorageKey(userId, hash, ext);
  await localStorage.delete(storageKey);
}

/** 资产创建后递增文件引用计数 */
export async function addAssetRef(hash: string, userId: number): Promise<void> {
  try {
    await incrementRefCount(hash, userId);
  } catch (e) {
    logger.warn({ hash, err: e }, "[ref-manager] addAssetRef failed");
  }
}

/** 资产删除后递减文件引用计数，归零则 GC 物理文件 */
export async function removeAssetRef(hash: string, userId: number): Promise<void> {
  try {
    const result = await decrementRefCount(hash, userId);
    if (result?.needGc) {
      await deletePhysicalFile(userId, hash, result.ext);
    }
  } catch (e) {
    logger.warn({ hash, err: e }, "[ref-manager] removeAssetRef failed");
  }
}

/**
 * 画布更新时 diff 增减引用计数。
 * - 新增的 hash -> increment
 * - 移除的 hash -> decrement（内部处理 GC）
 * - 不变的 hash -> 不动
 */
export async function recalcCanvasRefs(
  userId: number,
  oldHashes: string[],
  newHashes: string[],
): Promise<void> {
  try {
    const oldSet = new Set(oldHashes);
    const newSet = new Set(newHashes);

    const added = newHashes.filter((h) => !oldSet.has(h));
    const removed = oldHashes.filter((h) => !newSet.has(h));

    // 并行处理所有增减
    const tasks: Promise<void>[] = [
      ...added.map((h) => incrementRefCount(h, userId)),
      ...removed.map(async (h) => {
        const result = await decrementRefCount(h, userId);
        if (result?.needGc) {
          await deletePhysicalFile(userId, h, result.ext);
        }
      }),
    ];

    await Promise.all(tasks);
  } catch (e) {
    logger.warn({ err: e }, "[ref-manager] recalcCanvasRefs failed");
  }
}

/** 画布删除时递减所有文件引用计数，归零则 GC 物理文件 */
export async function cleanCanvasRefs(
  userId: number,
  hashes: string[],
): Promise<void> {
  try {
    await Promise.all(
      hashes.map(async (h) => {
        const result = await decrementRefCount(h, userId);
        if (result?.needGc) {
          await deletePhysicalFile(userId, h, result.ext);
        }
      }),
    );
  } catch (e) {
    logger.warn({ err: e }, "[ref-manager] cleanCanvasRefs failed");
  }
}
