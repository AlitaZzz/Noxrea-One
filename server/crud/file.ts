/**
 * 文件对象 CRUD。
 * 基于内容哈希去重存储文件元数据，并提供文件对象的 upsert 与查询。
 */
import { prisma } from "@server/core/database/client";

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

// ── 引用计数操作 ──

/** 原子递增文件引用计数（upsert：处理行可能已被 GC 的情况） */
export async function incrementRefCount(hash: string, userId: number): Promise<void> {
  await prisma.fileObject.upsert({
    where: { userId_hash: { userId, hash } },
    update: { refCount: { increment: 1 } },
    create: {
      userId,
      hash,
      refCount: 1,
      size: 0,
      mimeType: "",
      ext: "",
    },
  });
}

/** 原子递减文件引用计数，归零则条件删除行，返回是否需要 GC 物理文件 */
export async function decrementRefCount(
  hash: string,
  userId: number,
): Promise<{ needGc: boolean; ext: string } | null> {
  try {
    const updated = await prisma.fileObject.update({
      where: { userId_hash: { userId, hash } },
      data: { refCount: { decrement: 1 } },
      select: { refCount: true, ext: true },
    });

    if (updated.refCount <= 0) {
      // 条件删除：只有 refCount 确实是 0 才删行
      const deleted = await prisma.fileObject.deleteMany({
        where: { userId, hash, refCount: 0 },
      });
      if (deleted.count > 0) {
        return { needGc: true, ext: updated.ext };
      }
    }
    return { needGc: false, ext: updated.ext };
  } catch (e: unknown) {
    // P2025: 记录不存在（已 GC 或从未创建），忽略
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2025") {
      return null;
    }
    throw e;
  }
}
