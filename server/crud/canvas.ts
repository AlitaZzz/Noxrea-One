/**
 * 画布工程 CRUD。
 * 保留查询、创建、存在性探测与删除等单聚合操作，以及供写用例组合的事务内单表原语；
 * 编辑权租约、版本冲突与引用账本编排属于跨聚合用例，见 services/canvas/project-write。
 */
import { prisma } from "@server/core/database/client";
import { Prisma, type CanvasProject } from "@server/core/database/generated/client";
import { withTransaction, type DbTx } from "@server/core/database/transaction";
import { newId } from "@server/utils/id";
import { deriveCanvasSummary, toProjectSummary } from "@server/utils/canvas-summary";
import { removeSourceFileRefsTx } from "./file-ref-ledger";
import { stringifyJson, parseJsonObject } from "./json-column";

/** 返回给 HTTP 的完整工程行：`canvasData` 已解析为对象。 */
export type ProjectRow = Omit<CanvasProject, "canvasData"> & {
  canvasData: Record<string, unknown>;
};

declare const projectWriteRowBrand: unique symbol;

/**
 * 写用例读取的事务内行投影：仅写判定所需字段，不扩大读取面。
 * 品牌字段不可导出：只有 `getProjectRowForWriteTx` 的返回值能作为
 * `updateProjectRowTx` 的入参，外部构造的行在类型层即被拒绝。
 */
export interface ProjectWriteRow {
  readonly [projectWriteRowBrand]: never;
  id: string;
  revision: number;
  canvasData: Record<string, unknown>;
  coverKey: string | null;
}

/**
 * 项目行可写列补丁：字段缺省表示不更新该列；`coverKey: null` 表示清空封面。
 * 该类型是 `updateProjectRowTx` 的公开参数契约，导出供写用例命名复用。
 */
export interface ProjectWritePatch {
  name?: string;
  canvasData?: Record<string, unknown>;
  coverKey?: string | null;
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
      coverKey: true,
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

/**
 * 创建空画布工程（specs/web-module-contracts.md）：只接收名称，不接收初始画布内容。
 * 返回值不含 canvasData：创建接口只下发项目摘要所需列，画布内容由会话握手读取。
 * 空画布没有文件引用，因此不产生 file_refs 行；账本行由后续保存按 hash 按需创建。
 */
export async function createProject(userId: number, data: { name?: string }) {
  return withTransaction(async (tx) => {
    const summary = deriveCanvasSummary({});
    const project = await tx.canvasProject.create({
      data: {
        id: newId(),
        userId,
        name: data.name ?? "Untitled",
        canvasData: stringifyJson({}),
        nodeCount: summary.nodeCount,
        thumbnailSrc: summary.thumbnailSrc,
      },
      select: {
        id: true,
        userId: true,
        name: true,
        revision: true,
        coverKey: true,
        nodeCount: true,
        thumbnailSrc: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return project;
  });
}

/**
 * 项目存在性探测（SSE 连接前的 404 语义检查）：只查存在性，不读全量 canvasData。
 * 权威快照由握手在写临界区内另行读取，此处重复读无意义。
 */
export async function projectExists(id: string, userId: number): Promise<boolean> {
  const row = await prisma.canvasProject.findFirst({ where: { id, userId }, select: { id: true } });
  return row !== null;
}

/**
 * 事务内读取写判定所需行投影。
 * 写用例只能把本函数返回的行传给 `updateProjectRowTx`；不接受外部构造的行。
 */
export async function getProjectRowForWriteTx(
  tx: DbTx,
  id: string,
  userId: number,
): Promise<ProjectWriteRow | null> {
  const row = await tx.canvasProject.findFirst({
    where: { id, userId },
    select: { id: true, revision: true, canvasData: true, coverKey: true },
  });
  if (!row) return null;
  // 品牌只在这里落下：行必须是本事务内刚读到的投影，不接受外部构造
  return {
    id: row.id,
    revision: row.revision,
    canvasData: parseJsonObject(row.canvasData),
    coverKey: row.coverKey,
  } as ProjectWriteRow;
}

/**
 * 按同一事务内读到的行写入画布工程。
 * 只做单表写入：不做版本冲突判定、不解析封面、不写账本、不抛业务错误。
 * 内容字段写入时派生摘要并以数据库原子递增 revision。
 * 行在事务内被并发删除时由 Prisma P2025 映射为 null。
 */
export async function updateProjectRowTx(
  tx: DbTx,
  row: ProjectWriteRow,
  patch: ProjectWritePatch,
): Promise<ProjectRow | null> {
  const data: Prisma.CanvasProjectUncheckedUpdateInput = {};
  if (patch.name !== undefined) {
    data.name = patch.name;
  }
  if (patch.canvasData !== undefined) {
    data.canvasData = stringifyJson(patch.canvasData);
    data.revision = { increment: 1 };
    // 摘要冗余列随保存派生；画布 JSON 在同一事务内本就要解析用于账本对比
    const summary = deriveCanvasSummary(patch.canvasData);
    data.nodeCount = summary.nodeCount;
    data.thumbnailSrc = summary.thumbnailSrc;
  }
  if (patch.coverKey !== undefined) {
    data.coverKey = patch.coverKey;
  }

  try {
    const updated = await tx.canvasProject.update({ where: { id: row.id }, data });
    return {
      ...updated,
      canvasData: parseJsonObject(updated.canvasData),
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return null;
    }
    throw error;
  }
}

/** 只读当前版本；供写用例在进入事务前构造租约失效错误。 */
export async function getProjectRevision(id: string, userId: number): Promise<number | null> {
  const row = await prisma.canvasProject.findFirst({
    where: { id, userId },
    select: { revision: true },
  });
  return row?.revision ?? null;
}

export async function deleteProject(id: string, userId: number) {
  return withTransaction(async (tx) => {
    // 先删除项目行并持有行锁，再清理账本：并发保存/封面写要么先提交
    // （随后被本次清理按最新账本回收），要么在行删除后得到 P2025 而不会写账本。
    // 反过来先清账再删行会留下并发写入新插入的孤儿 file_refs。
    const deleted = await tx.canvasProject.deleteMany({ where: { id, userId } });
    if (deleted.count === 0) return deleted;

    // 封面来源（canvas_cover）一并清理，封面文件随项目走 GC 宽限期回收
    await removeSourceFileRefsTx(tx, {
      userId,
      sourceType: "canvas",
      sourceId: id,
    });
    await removeSourceFileRefsTx(tx, {
      userId,
      sourceType: "canvas_cover",
      sourceId: id,
    });
    return deleted;
  });
}
