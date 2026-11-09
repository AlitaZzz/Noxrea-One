/**
 * 画布工程写用例（specs/server-crud-service-boundary.md 第 2 节）。
 *
 * 编辑权租约、fencing、版本冲突与引用账本编排属于跨聚合用例：
 * - 行读写只经 `crud/canvas` 的事务内原语，不直接访问 `tx.canvasProject.*`；
 * - 增量合并只经 `utils/canvas-delta`，摘要与引用计数只经 `utils/canvas-*`；
 * - 内容与封面在同一事务内落库，`null` 表示清空封面，纯改名不触碰封面账本。
 */
import { hashFromStorageKey } from "@noxrea/shared/url";
import { withTransaction, type DbTx } from "@server/core/database/transaction";
import {
  getProjectRevision,
  getProjectRowForWriteTx,
  updateProjectRowTx,
  type ProjectRow,
  type ProjectWritePatch,
  type ProjectWriteRow,
} from "@server/crud/canvas";
import { replaceSourceFileRefsTx, replaceSourceFileRefTx } from "@server/crud/file-ref-ledger";
import type { CanvasDelta } from "@server/schemas/canvas";
import { applyCanvasDelta } from "@server/utils/canvas-delta";
import { extractHashCountsFromCanvas, hashCountsEqual } from "@server/utils/canvas-hashes";
import { isCurrentLease, withProjectGate } from "@server/services/canvas/editor-lease";

/** 画布版本冲突错误；currentRevision 帮助前端同步到服务端最新版本。 */
export class CanvasRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super("canvas project revision conflict");
  }
}

/** 封面引用不是存储 key 严格形态（无法登记引用账本防 GC） */
export class CanvasCoverKeyError extends Error {
  constructor() {
    super("cover ref is not a storage key");
  }
}

/**
 * 编辑权租约失效：请求携带的租约令牌已被其他页面实例的握手轮换掉。
 * 与版本冲突同形映射为 409（前端处理收敛为「同步版本 + 进入过期态」，无需分叉）；
 * currentRevision 供 409 响应回传，前端据此同步 revision。
 */
export class CanvasLeaseLostError extends Error {
  constructor(readonly currentRevision: number | null) {
    super("canvas editor lease lost");
  }
}

async function leaseLostError(id: string, userId: number): Promise<CanvasLeaseLostError> {
  const revision = await getProjectRevision(id, userId);
  return new CanvasLeaseLostError(revision);
}

/** 封面 key 严格解析：`null` 表示清空，`undefined` 表示不修改，其余必须是存储 key。 */
function assertCoverKey(coverKey: string | null | undefined): void {
  if (coverKey !== undefined && coverKey !== null && !hashFromStorageKey(coverKey)) {
    throw new CanvasCoverKeyError();
  }
}

/** 事务内按账本对比写入画布内容来源；布局保存（引用集合未变）零账本写入。 */
async function writeContentLedgerIfChanged(
  tx: DbTx,
  userId: number,
  projectId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<void> {
  const oldCounts = extractHashCountsFromCanvas(before);
  const newCounts = extractHashCountsFromCanvas(after);
  if (!hashCountsEqual(oldCounts, newCounts)) {
    await replaceSourceFileRefsTx(tx, {
      userId,
      sourceType: "canvas",
      sourceId: projectId,
    }, newCounts);
  }
}

/**
 * 按同一事务内读取的行写入项目并维护派生账本。
 * `canvasData` 仅在提供时做引用 diff（元数据写不触碰内容账本）；
 * `coverKey` 仅在提供时替换封面账本（undefined 表示不修改，null 表示清空）。
 * 行已被并发删除时返回 null 且不写账本。
 */
async function writeProjectRowWithLedgersTx(
  tx: DbTx,
  userId: number,
  row: ProjectWriteRow,
  patch: ProjectWritePatch,
): Promise<ProjectRow | null> {
  assertCoverKey(patch.coverKey);
  const updated = await updateProjectRowTx(tx, row, patch);
  if (!updated) return null;

  if (patch.canvasData !== undefined) {
    await writeContentLedgerIfChanged(tx, userId, row.id, row.canvasData, patch.canvasData);
  }
  if (patch.coverKey !== undefined) {
    await replaceSourceFileRefTx(tx, {
      userId,
      sourceType: "canvas_cover",
      sourceId: row.id,
    }, patch.coverKey);
  }
  return updated;
}

/** 画布内容写的公共选项：编辑权租约令牌 + 客户端基线版本。 */
export interface CanvasWriteOptions {
  baseRevision?: number;
  lease?: number;
}

/**
 * 画布内容写的唯一前置路径：编辑权租约 fencing、版本号存在性校验与事务内
 * 版本冲突判定都在这里完成，调用方只提供事务内的写动作。
 *
 * 租约校验与事务整体进入每项目写临界区，与 SSE 握手的「轮换租约 + 快照读」
 * 互斥不交错——被接管的旧持有者的迟到写入无论落在握手哪一侧，都会被租约
 * 校验结构性拒绝（fencing token）。
 *
 * 路由已拒绝缺失 baseRevision 的内容写；service 入口仍 fail-closed，避免
 * 内部调用绕过版本判定。行已被并发删除时返回 null 且不写账本。
 */
async function withContentWriteTx<T>(
  id: string,
  userId: number,
  options: CanvasWriteOptions | undefined,
  write: (tx: DbTx, row: ProjectWriteRow) => Promise<T>,
): Promise<T | null> {
  return withProjectGate(id, async () => {
    if (options?.lease === undefined || !isCurrentLease(id, options.lease)) {
      throw await leaseLostError(id, userId);
    }
    const { baseRevision } = options;
    if (baseRevision === undefined) {
      throw new Error("canvas content write requires baseRevision");
    }
    return withTransaction(async (tx) => {
      const row = await getProjectRowForWriteTx(tx, id, userId);
      if (!row) return null;
      if (row.revision !== baseRevision) {
        throw new CanvasRevisionConflictError(row.revision);
      }
      return write(tx, row);
    });
  });
}

export async function updateProject(
  id: string,
  userId: number,
  data: ProjectWritePatch,
  options?: CanvasWriteOptions,
) {
  // 改名 / 封面是元数据：不递增 revision、不参与编辑权，无需进临界区。
  const { canvasData } = data;
  if (canvasData === undefined) {
    return withTransaction(async (tx) => {
      const row = await getProjectRowForWriteTx(tx, id, userId);
      if (!row) return null;
      return writeProjectRowWithLedgersTx(tx, userId, row, {
        name: data.name,
        coverKey: data.coverKey,
      });
    });
  }

  return withContentWriteTx(id, userId, options, (tx, row) =>
    writeProjectRowWithLedgersTx(tx, userId, row, {
      name: data.name,
      canvasData,
      coverKey: data.coverKey,
    }),
  );
}

/**
 * 合并卸载阶段的画布增量。读取、合并、摘要派生、文件引用账本和 revision
 * 都在同一项目写临界区与数据库事务内完成，避免增量请求成为另一条弱写路径。
 */
export async function updateProjectDelta(
  id: string,
  userId: number,
  delta: CanvasDelta,
  options?: CanvasWriteOptions,
) {
  return withContentWriteTx(id, userId, options, (tx, row) =>
    writeProjectRowWithLedgersTx(tx, userId, row, {
      canvasData: applyCanvasDelta(row.canvasData, delta),
    }),
  );
}
