/**
 * 文件引用管理服务。
 * 统一管理资产与画布对文件的引用追踪，以及孤儿文件的 GC。
 */
import { prisma } from "@server/core/database/client";
import {
  addFileReference,
  deleteFileReferences,
  getFileReferences,
  getFileObject,
} from "@server/crud/file";
import { recalcFileReferences } from "@server/crud/canvas";
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

/** 资产创建后添加引用 */
export async function addAssetRef(
  assetId: number,
  hash: string,
  userId: number,
): Promise<void> {
  try {
    await addFileReference({
      fileHash: hash,
      userId,
      refType: "asset",
      refId: assetId,
    });
  } catch (e) {
    // 唯一键冲突等错误不影响资产创建
    logger.warn(`[ref-manager] addAssetRef failed: asset=${assetId} hash=${hash}`, e);
  }
}

/** 资产删除后清理引用 */
export async function removeAssetRef(assetId: number): Promise<void> {
  try {
    await deleteFileReferences("asset", assetId);
  } catch (e) {
    logger.warn(`[ref-manager] removeAssetRef failed: asset=${assetId}`, e);
  }
}

/** 画布更新时重算文件引用，并对被移除的 hash 做 GC */
export async function recalcCanvasRefs(
  projectId: number,
  userId: number,
  hashes: string[],
): Promise<void> {
  try {
    // 记录旧 hash 集合
    const oldRefs = await getFileReferences("canvas_project", projectId);
    const oldHashes = new Set(oldRefs.map((r) => r.fileHash));

    // 重算引用
    const fileHashes = hashes.map((h) => ({ hash: h, userId, refType: "canvas_project" }));
    await recalcFileReferences(projectId, fileHashes);

    // 对旧集合 - 新集合的差集做 GC
    const newHashes = new Set(hashes);
    for (const old of oldHashes) {
      if (!newHashes.has(old)) {
        await gcFileIfOrphaned(old, userId);
      }
    }
  } catch (e) {
    logger.warn(`[ref-manager] recalcCanvasRefs failed: project=${projectId}`, e);
  }
}

/** 画布删除时清理文件引用，并对受影响的 hash 做 GC */
export async function cleanCanvasRefs(
  projectId: number,
  userId: number,
): Promise<void> {
  try {
    const refs = await getFileReferences("canvas_project", projectId);
    const hashes = refs.map((r) => r.fileHash);

    await deleteFileReferences("canvas_project", projectId);

    for (const hash of hashes) {
      await gcFileIfOrphaned(hash, userId);
    }
  } catch (e) {
    logger.warn(`[ref-manager] cleanCanvasRefs failed: project=${projectId}`, e);
  }
}

/** 引用为 0 时删除物理文件 + FileObject 记录 */
export async function gcFileIfOrphaned(
  hash: string,
  userId: number,
): Promise<void> {
  try {
    const count = await prisma.fileReference.count({
      where: { fileHash: hash, userId },
    });
    if (count > 0) return;

    const fileObj = await getFileObject(userId, hash);
    if (!fileObj) return;

    const storageKey = buildStorageKey(userId, hash, fileObj.ext);
    await localStorage.delete(storageKey);

    await prisma.fileObject.delete({
      where: {
        userId_hash: { userId, hash },
      },
    });
  } catch (e) {
    logger.warn(`[ref-manager] gcFileIfOrphaned failed: hash=${hash}`, e);
  }
}
