/**
 * 文件对象 CRUD。
 * 基于内容哈希去重存储文件元数据，并提供文件对象的 upsert 与查询。
 */
import { prisma } from "@server/core/database/client";
import { Prisma } from "@prisma/client";

// FileObject upsert（去重：hash 碰撞时更新）
export async function upsertFileObject(data: {
  userId: number;
  hash: string;
  size: number;
  mimeType: string;
  ext: string;
  source?: string;
}) {
  const now = new Date();

  return prisma.fileObject.upsert({
    where: {
      userId_hash: {
        userId: data.userId,
        hash: data.hash,
      },
    },
    update: {
      size: data.size,
      mimeType: data.mimeType,
      ext: data.ext,
      source: data.source ?? "unknown",
      updatedAt: now,
    },
    create: {
      userId: data.userId,
      hash: data.hash,
      size: data.size,
      mimeType: data.mimeType,
      ext: data.ext,
      source: data.source ?? "unknown",
    },
  });
}

export async function getFileObject(userId: number, hash: string) {
  return prisma.fileObject.findUnique({
    where: {
      userId_hash: { userId, hash },
    },
  });
}

export async function getFileObjectByHash(hash: string) {
  return prisma.fileObject.findFirst({
    where: { hash },
  });
}

// ── 引用聚合计数操作 ──

/**
 * 按账本差值调整文件引用聚合计数。
 * 正数递增，负数递减；归零时保留记录，交由后续 GC 流程统一判断。
 */
export async function adjustFileRefCount(
  tx: Prisma.TransactionClient,
  userId: number,
  hash: string,
  delta: number,
): Promise<void> {
  if (delta === 0) return;

  if (delta > 0) {
    await tx.fileObject.upsert({
      where: { userId_hash: { userId, hash } },
      update: { refCount: { increment: delta } },
      create: {
        userId,
        hash,
        refCount: delta,
        size: 0,
        mimeType: "",
        ext: "",
      },
    });
    return;
  }

  try {
    await tx.fileObject.update({
      where: { userId_hash: { userId, hash } },
      data: { refCount: { decrement: -delta } },
    });
  } catch (error) {
    // 账本删除不应被缺失的聚合行阻塞；这类缺失只说明文件对象已被外部清理。
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return;
    }
    throw error;
  }
}
