import { prisma } from "@server/core/database/client";

// ── File CRUD（对应 backend/app/models/file_object.py 相关操作） ──

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

// FileReference
export async function addFileReference(data: {
  fileHash: string;
  userId: number;
  refType: string;
  refId: number;
}) {
  return prisma.fileReference.create({
    data: {
      fileHash: data.fileHash,
      userId: data.userId,
      refType: data.refType,
      refId: data.refId,
    },
  });
}

export async function getFileReferences(refType: string, refId: number) {
  return prisma.fileReference.findMany({
    where: { refType, refId },
  });
}

export async function deleteFileReferences(refType: string, refId: number) {
  return prisma.fileReference.deleteMany({
    where: { refType, refId },
  });
}
