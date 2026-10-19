/**
 * 存储引用 GC。
 *
 * 引用计数归零且超过宽限期的 FileObject 视为孤儿内容，经二次对账后回收：
 * 事务内终检删行 → 删磁盘文件。宽限期覆盖撤销 / 恢复等「引用短暂清零又回来」的场景。
 *
 * 安全护栏：
 * - 候选池排除（SQL 层）：聚合计数（ref_count）只是账本 file_refs 的聚合结果可能漂移、
 *   agent_messages.ref_images 以 JSON 文本引用文件 URL 不走账本、扩展名缺失无法定位
 *   文件——三类不可回收行在候选查询里即被排除（账本行与 Agent 引用是相关 EXISTS 负向
 *   谓词），不占用批名额；FIFO（updatedAt 升序）批上限下的消化进度因此真正有保证，
 *   不会被永久保护行堵死队头。三类排除量以同口径统计查询照常上报（对全部候选统计）。
 * - 事务终检：行删除在事务里重读 refCount 并确认账本无行；引用在扫描后回到的
 *   （撤销恢复 / 二次引用）终检放弃回收。残余竞态（引用恰好在删行与删文件之间回来）
 *   窗口为毫秒级，远小于 48h 宽限期语义，此时最多留下一个无账本行的孤儿磁盘文件，
 *   不影响任何引用的完整性。
 * - storage.gc_dry_run：引用回收与 staging 清扫都只报告不删除，观察扫描结果后再切换实删。
 *
 * 启动后延迟首跑 + 每日一次（进程内 interval），由 bootstrap 挂载，幂等。
 */
import { Prisma } from "@server/core/database/generated/client";
import { prisma } from "@server/core/database/client";
import { getSetting } from "@server/core/settings";
import { buildStorageKey, getStorageBackend } from "./service";
import { sweepStagingObjects } from "./upload-direct";
import { sweepStaleDerivedObjects } from "./derived-cleanup";
import { logEvent } from "@server/core/logger/utils";

const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 启动后延迟首跑：避开启动高峰，也不阻塞首个请求 */
const GC_STARTUP_DELAY_MS = 60 * 1000;
/** 单轮扫描上限：孤儿数量异常膨胀时分多天消化，避免长事务 */
const GC_BATCH_SIZE = 500;

export interface StorageGcReport {
  dryRun: boolean;
  scannedAt: string;
  /** refCount 归零、超宽限期且不在任何保护类的候选数（本批，FIFO 升序前 GC_BATCH_SIZE 个） */
  candidates: number;
  /** 账本仍有行（聚合计数漂移）：候选池 SQL 层排除，对全部候选统计 */
  ledgerProtected: number;
  /** Agent 消息仍在引用（历史参考图不失效）：候选池 SQL 层排除，对全部候选统计 */
  agentProtected: number;
  /** 扩展名缺失无法定位磁盘文件：候选池 SQL 层排除，保留行待人工排查 */
  unlocatable: number;
  /** 终检发现引用已回来或行已消失：保留行，后续轮次再判 */
  skipped: number;
  /** 实删成功的清单（dry-run 时为将要回收的清单） */
  reclaimed: Array<{ userId: number; hash: string; key: string; size: number }>;
}

// 两个排除谓词的单一形状来源：候选池排除与排除量统计共用，列名漂移只改这里
const ledgerRefExists = Prisma.sql`EXISTS (SELECT 1 FROM file_refs fr WHERE fr.user_id = fo.user_id AND fr.hash = fo.hash)`;
const agentRefExists = Prisma.sql`EXISTS (SELECT 1 FROM agent_messages am WHERE am.ref_images LIKE '%' || fo.hash || '%')`;

/** 候选查询的行投影（raw SQL 直取，字段为数据库列名映射后的最小集） */
interface GcCandidateRow {
  user_id: number;
  hash: string;
  size: bigint;
  ext: string;
}

/** 排除量统计行（COUNT FILTER 聚合，与候选查询同一 WHERE 前置条件） */
interface GcExcludedCounts {
  unlocatable: bigint;
  ledger_protected: bigint;
  agent_protected: bigint;
}

export async function runStorageGc(): Promise<StorageGcReport> {
  const dryRun = getSetting("storage.gc_dry_run");
  const cutoff = new Date(Date.now() - getSetting("storage.gc_grace_hours") * 3_600_000);

  // 候选池在 SQL 层即排除三类不可回收行（账本保护 / Agent 引用 / 扩展名缺失），
  // 永久保护行不占批名额；FIFO（updatedAt 升序）批上限下的消化进度真正有保证。
  // hash 是库内 64 位十六进制列，参数化拼接仅命中原样值，无注入面。
  const rows = await prisma.$queryRaw<GcCandidateRow[]>(Prisma.sql`
    SELECT fo.user_id, fo.hash, fo.size, fo.ext
    FROM file_objects fo
    WHERE fo.ref_count <= 0
      AND fo.updated_at < ${cutoff}
      AND fo.ext LIKE '.%'
      AND NOT ${ledgerRefExists}
      AND NOT ${agentRefExists}
    ORDER BY fo.updated_at ASC
    LIMIT ${GC_BATCH_SIZE}
  `);

  // 排除量上报：同 WHERE 前置条件对全部候选统计（非仅本批），保持可观测性
  const [counts] = await prisma.$queryRaw<GcExcludedCounts[]>(Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE fo.ext NOT LIKE '.%') AS unlocatable,
      COUNT(*) FILTER (WHERE fo.ext LIKE '.%' AND ${ledgerRefExists}) AS ledger_protected,
      COUNT(*) FILTER (WHERE fo.ext LIKE '.%' AND NOT ${ledgerRefExists} AND ${agentRefExists}) AS agent_protected
    FROM file_objects fo
    WHERE fo.ref_count <= 0 AND fo.updated_at < ${cutoff}
  `);

  const report: StorageGcReport = {
    dryRun,
    scannedAt: new Date().toISOString(),
    candidates: rows.length,
    ledgerProtected: Number(counts?.ledger_protected ?? 0),
    agentProtected: Number(counts?.agent_protected ?? 0),
    unlocatable: Number(counts?.unlocatable ?? 0),
    skipped: 0,
    reclaimed: [],
  };
  if (rows.length === 0) return report;

  const reclaimable: Array<{ userId: number; hash: string; key: string; size: number }> = rows.map(
    (row) => ({
      userId: row.user_id,
      hash: row.hash,
      key: buildStorageKey(row.user_id, row.hash, row.ext),
      size: Number(row.size),
    }),
  );

  if (report.dryRun) {
    report.reclaimed = reclaimable;
    return report;
  }

  for (const item of reclaimable) {
    // 事务内终检删行：引用在扫描后回来的（撤销恢复 / 二次引用）立即放弃
    const deleted = await prisma
      .$transaction(async (tx) => {
        const fresh = await tx.fileObject.findUnique({
          where: { userId_hash: { userId: item.userId, hash: item.hash } },
          select: { refCount: true },
        });
        if (!fresh || fresh.refCount > 0) return false;
        const refRow = await tx.fileRef.findFirst({
          where: { userId: item.userId, hash: item.hash },
          select: { id: true },
        });
        if (refRow) return false;
        await tx.fileObject.delete({
          where: { userId_hash: { userId: item.userId, hash: item.hash } },
        });
        return true;
      })
      .catch(() => false);

    if (!deleted) {
      report.skipped += 1;
      continue;
    }
    report.reclaimed.push(item);

    await getStorageBackend().delete(item.key);
    // backend.delete 会吞掉句柄占用类失败：文件若仍在，只是留下一个
    // 无账本行的孤儿磁盘文件，不影响任何引用，记录留痕即可
    const stat = await getStorageBackend().stat(item.key).catch(() => null);
    if (stat) {
      logEvent("gc", { stage: "file_still_present", key: item.key });
    }
  }

  return report;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** GC 单周期结果：两阶段各自的报告与错误（阶段吞错不改判对方成败，调用方据此处置） */
export interface GcCycleResult {
  /** 引用回收报告；阶段抛错为 null */
  gc: StorageGcReport | null;
  gcError: string | null;
  /** staging 清扫回收数；阶段抛错为 null */
  swept: number | null;
  sweepError: string | null;
  /** 派生清扫回收数（四根统一 TTL，specs/derived-deletion-linkage.md 规则 4）；阶段抛错为 null */
  derivedSwept: number | null;
  derivedSweepError: string | null;
}

/**
 * GC 单周期：引用回收 + staging 按龄清扫 + 派生按龄清扫，三阶段独立成败。
 * 进程内定时 tick 与 storage:gc 手动触发共用同一实现（护栏口径单一来源），
 * 结果返回给调用方各按需消费（tick 落日志，CLI 置退出码）。
 */
export async function runGcCycle(): Promise<GcCycleResult> {
  let gc: StorageGcReport | null = null;
  let gcError: string | null = null;
  let swept: number | null = null;
  let sweepError: string | null = null;
  let derivedSwept: number | null = null;
  let derivedSweepError: string | null = null;
  try {
    gc = await runStorageGc();
    logEvent("gc", {
      stage: "done",
      dryRun: gc.dryRun,
      candidates: gc.candidates,
      ledgerProtected: gc.ledgerProtected,
      agentProtected: gc.agentProtected,
      unlocatable: gc.unlocatable,
      skipped: gc.skipped,
      reclaimed: gc.reclaimed.length,
    });
  } catch (err) {
    gcError = String(err);
    logEvent("gc", { stage: "failed", error: gcError });
  }
  // staging 清扫与孤儿回收同一节奏但独立成败：一方失败不拖累另一方
  try {
    swept = await sweepStagingObjects();
    logEvent("gc", { stage: "staging_swept", swept, dryRun: getSetting("storage.gc_dry_run") });
  } catch (err) {
    sweepError = String(err);
    logEvent("gc", { stage: "staging_sweep_failed", error: sweepError });
  }
  // 派生按龄清扫（四根统一 TTL）：同一节奏独立成败，specs/derived-deletion-linkage.md 规则 4
  try {
    derivedSwept = await sweepStaleDerivedObjects();
    logEvent("gc", { stage: "derived_swept", swept: derivedSwept, dryRun: getSetting("storage.gc_dry_run") });
  } catch (err) {
    derivedSweepError = String(err);
    logEvent("gc", { stage: "derived_sweep_failed", error: derivedSweepError });
  }
  return { gc, gcError, swept, sweepError, derivedSwept, derivedSweepError };
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  // latch 释放不依赖任何内部日志调用不抛错：整个 tick 体由 finally 兜底
  try {
    await runGcCycle();
  } finally {
    running = false;
  }
}

/** 启动 GC 循环（幂等）：延迟首跑 + 每日一次 */
export function startStorageGc(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), GC_INTERVAL_MS);
  timer.unref?.();
  const first = setTimeout(() => void tick(), GC_STARTUP_DELAY_MS);
  first.unref?.();
  logEvent("gc", { stage: "scheduled", intervalMs: GC_INTERVAL_MS });
}
