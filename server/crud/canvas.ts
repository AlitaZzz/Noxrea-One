/**
 * 画布工程 CRUD。
 * 按用户读写画布工程、节点数据与缩略图等持久化信息。
 */
import { prisma } from "@server/core/database/client";
import { newId } from "@server/utils/id";
import { extractHashCountsFromCanvas, extractHashFromUrl, hashCountsEqual } from "@server/services/canvas/extract-hashes";
import { deriveCanvasSummary, toProjectSummary } from "@server/services/canvas/project-summary";
import {
  replaceSourceFileRefs,
  removeSourceFileRefs,
} from "@server/services/storage/file-ref-ledger";
import { stringifyJson, parseJsonObject } from "./json-column";

/** 画布版本冲突错误；currentRevision 帮助前端同步到服务端最新版本。 */
export class CanvasRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("canvas project revision conflict");
  }
}

/** 封面 URL 不是本站 /api/files/ 内容寻址地址（无法登记引用账本防 GC） */
export class CanvasCoverUrlError extends Error {
  constructor() {
    super("cover url is not a managed file url");
  }
}

export async function getProjects(userId: number) {
  // 摘要冗余列在保存路径维护，列表不再读取全量 canvasData（读放大根治）
  const rows = await prisma.canvasProject.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      revision: true,
      updatedAt: true,
      coverUrl: true,
      nodeCount: true,
      thumbnailSrc: true,
    },
  });
  return rows.map(toProjectSummary);
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
    const summary = deriveCanvasSummary(data.canvasData ?? {});
    const project = await tx.canvasProject.create({
      data: {
        id: newId(),
        userId,
        name: data.name ?? "Untitled",
        canvasData: stringifyJson(data.canvasData ?? {}),
        nodeCount: summary.nodeCount,
        thumbnailSrc: summary.thumbnailSrc,
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
  data: { name?: string; canvasData?: Record<string, unknown>; coverUrl?: string | null },
  options?: { baseRevision?: number }
) {
  return prisma.$transaction(async (tx) => {
    // 事务内读取当前版本；旧请求的 baseRevision 不一致时立即拒绝。
    // 版本校验只针对画布内容：revision 语义 = 画布内容版本，纯改名 / 改封面是元数据、
    // 不参与冲突判定也不递增版本——否则改名会把其他窗口的画布会话误杀成过期。
    const existing = await tx.canvasProject.findFirst({
      where: { id, userId },
      select: { id: true, revision: true, canvasData: true },
    });
    if (!existing) return null;
    if (
      data.canvasData !== undefined &&
      options?.baseRevision !== undefined &&
      existing.revision !== options.baseRevision
    ) {
      throw new CanvasRevisionConflictError(existing.revision);
    }

    const updateData: Record<string, unknown> = {};
    let coverHash: string | null = null;
    if (data.name !== undefined) {
      updateData.name = data.name;
    }
    if (data.canvasData !== undefined) {
      updateData.canvasData = stringifyJson(data.canvasData);
      updateData.revision = { increment: 1 };
      // 摘要冗余列随保存派生（画布 JSON 已在下方账本重算中解析，此处复用对象）
      const summary = deriveCanvasSummary(data.canvasData);
      updateData.nodeCount = summary.nodeCount;
      updateData.thumbnailSrc = summary.thumbnailSrc;
    }
    if (data.coverUrl !== undefined) {
      // 封面必须能解析出本站文件 hash：引用账本按 hash 登记，防 GC 回收封面文件
      coverHash = data.coverUrl === null ? null : extractHashFromUrl(data.coverUrl);
      if (data.coverUrl !== null && !coverHash) {
        throw new CanvasCoverUrlError();
      }
      updateData.coverUrl = data.coverUrl;
    }

    const updated = await tx.canvasProject.update({
      where: { id },
      data: updateData,
    });

    // 引用账本重算由服务端权威判定：事务内比较落库前后的引用计数，
    // 仅媒体结构变化（引用集合或数量不同）才写账本；布局保存零账本写入。
    if (data.canvasData !== undefined) {
      const oldCounts = extractHashCountsFromCanvas(parseJsonObject(existing.canvasData));
      const newCounts = extractHashCountsFromCanvas(data.canvasData);
      if (!hashCountsEqual(oldCounts, newCounts)) {
        await replaceSourceFileRefs(tx, {
          userId,
          sourceType: "canvas",
          sourceId: id,
        }, newCounts);
      }
    }

    // 封面引用走独立来源（canvas_cover），与画布内容（canvas）正交：
    // 画布保存整替 canvas 来源集合，封面混入会被冲掉。清除封面（null）即清空该来源。
    if (data.coverUrl !== undefined) {
      await replaceSourceFileRefs(tx, {
        userId,
        sourceType: "canvas_cover",
        sourceId: id,
      }, coverHash ? new Map([[coverHash, 1]]) : new Map());
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
    // 封面来源（canvas_cover）一并清理，封面文件随项目走 GC 宽限期回收
    await removeSourceFileRefs(tx, {
      userId,
      sourceType: "canvas",
      sourceId: id,
    });
    await removeSourceFileRefs(tx, {
      userId,
      sourceType: "canvas_cover",
      sourceId: id,
    });
    return tx.canvasProject.deleteMany({ where: { id, userId } });
  });
}

