/**
 * 画布工程 CRUD。
 * 按用户读写画布工程、节点数据与缩略图等持久化信息。
 */
import { prisma } from "@server/core/database/client";
import { newId } from "@server/utils/id";
import { extractHashCountsFromCanvas } from "@server/utils/extract-hashes";
import {
  replaceSourceFileRefs,
  removeSourceFileRefs,
} from "@server/services/storage/file-ref-ledger";
import { stringifyJson, parseJsonObject } from "./_json";

/** 画布版本冲突错误；currentRevision 帮助前端同步到服务端最新版本。 */
export class CanvasRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("canvas project revision conflict");
  }
}

export async function getProjects(userId: number) {
  const projects = await prisma.canvasProject.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
  return projects.map((p) => ({
    ...p,
    canvasData: parseJsonObject(p.canvasData),
  }));
}

export async function getProject(id: string, userId: number) {
  const project = await prisma.canvasProject.findFirst({ where: { id, userId } });
  if (!project) return null;
  return {
    ...project,
    canvasData: parseJsonObject(project.canvasData),
  };
}

export async function createProject(
  userId: number,
  data: { name?: string; canvasData?: Record<string, unknown> }
) {
  return prisma.$transaction(async (tx) => {
    const project = await tx.canvasProject.create({
      data: {
        id: newId(),
        userId,
        name: data.name ?? "Untitled",
        canvasData: stringifyJson(data.canvasData ?? {}),
      },
    });

    // 画布创建时同步登记初始引用；空画布会得到空引用集合。
    await replaceSourceFileRefs(tx, {
      userId,
      sourceType: "canvas",
      sourceId: project.id,
    }, extractHashCountsFromCanvas(data.canvasData ?? {}));

    return {
      ...project,
      canvasData: parseJsonObject(project.canvasData),
    };
  });
}

export async function updateProject(
  id: string,
  userId: number,
  data: { name?: string; canvasData?: Record<string, unknown> },
  options?: { recalcRefs?: boolean; baseRevision?: number }
) {
  return prisma.$transaction(async (tx) => {
    // 事务内读取当前版本；旧请求的 baseRevision 不一致时立即拒绝。
    const existing = await tx.canvasProject.findFirst({
      where: { id, userId },
      select: { id: true, revision: true },
    });
    if (!existing) return null;
    if (
      options?.baseRevision !== undefined &&
      existing.revision !== options.baseRevision
    ) {
      throw new CanvasRevisionConflictError(existing.revision);
    }

    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) {
      updateData.name = data.name;
    }
    if (data.canvasData !== undefined) {
      updateData.canvasData = stringifyJson(data.canvasData);
    }

    const updated = await tx.canvasProject.update({
      where: { id },
      data: {
        ...updateData,
        revision: { increment: 1 },
      },
    });

    // 引用重算只在媒体结构变化时执行；拖动节点等布局保存不会解析引用。
    if (options?.recalcRefs && data.canvasData !== undefined) {
      await replaceSourceFileRefs(tx, {
        userId,
        sourceType: "canvas",
        sourceId: id,
      }, extractHashCountsFromCanvas(data.canvasData));
    }

    return {
      ...updated,
      canvasData: parseJsonObject(updated.canvasData),
    };
  });
}

export async function deleteProject(id: string, userId: number) {
  return prisma.$transaction(async (tx) => {
    // 先按账本递减聚合计数，再删除画布；两个操作在同一事务中回滚一致。
    await removeSourceFileRefs(tx, {
      userId,
      sourceType: "canvas",
      sourceId: id,
    });
    return tx.canvasProject.deleteMany({ where: { id, userId } });
  });
}

