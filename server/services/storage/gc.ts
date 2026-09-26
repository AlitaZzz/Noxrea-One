/**
 * 存储引用 GC。
 *
 * 引用计数归零且超过宽限期的 FileObject 视为孤儿内容，经二次对账后回收：
 * 事务内终检删行 → 删磁盘文件。宽限期覆盖撤销 / 恢复等「引用短暂清零又回来」的场景。
 *
 * 安全护栏：
 * - 账本二次对账：聚合计数（ref_count）只是账本的聚合结果，可能因历史缺陷漂移；
 *   账本（file_refs）里仍有行的 hash 一律不回收。
 * - Agent 会话保护：agent_messages.ref_images 以 JSON 文本引用文件 URL，不走账本；
 *   候选 hash 在其中出现的（LIKE 命中）一律保护，避免回收后历史消息里的参考图失效。
 * - 先删行后删文件：行删除在事务里重读 refCount 并确认账本无行；若引用在扫描后
 *   回到，事务终检会放弃回收。残余竞态（引用恰好在删行与删文件之间回来）窗口为
 *   毫秒级，远小于 48h 宽限期语义，此时最多留下一个无账本行的孤儿磁盘文件，
 *   不影响任何引用的完整性。
 * - GC_DRY_RUN：首版默认只报告不删除，观察扫描结果后再切换实删。
 *
 * 启动后延迟首跑 + 每日一次（进程内 interval），由 bootstrap 挂载，幂等。
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@server/core/database/client";
import { getConfig } from "@server/core/config";
import { buildStorageKey } from "./service";
import { localStorage } from "./backends/local";
import { logEvent } from "@server/core/logger/utils";

const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 启动后延迟首跑：避开启动高峰，也不阻塞首个请求 */
const GC_STARTUP_DELAY_MS = 60 * 1000;
/** 单轮扫描上限：孤儿数量异常膨胀时分多天消化，避免长事务 */
const GC_BATCH_SIZE = 500;

export interface StorageGcReport {
  dryRun: boolean;
  scannedAt: string;
  /** refCount 归零且超过宽限期的候选数 */
  candidates: number;
  /** 账本仍有行（聚合计数漂移）：保护不回收 */
  ledgerProtected: number;
  /** Agent 消息仍在引用：保护不回收 */
  agentProtected: number;
  /** 扩展名缺失无法定位磁盘文件：保留行待人工排查 */
  unlocatable: number;
  /** 终检发现引用已回来或行已消失：保留行，后续轮次再判 */
  skipped: number;
  /** 实删成功的清单（dry-run 时为将要回收的清单） */
  reclaimed: Array<{ userId: number; hash: string; key: string; size: number }>;
}

/** 判断候选是否被 Agent 消息引用（ref_images JSON 文本 LIKE 候选 hash） */
async function isAgentReferenced(hash: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>(
    // hash 是 64 位十六进制串，参数化拼接仅命中原样 hash，无注入面
    Prisma.sql`SELECT COUNT(*) AS n FROM agent_messages WHERE ref_images LIKE ${"%" + hash + "%"}`,
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function runStorageGc(): Promise<StorageGcReport> {
  const cfg = getConfig();
  const cutoff = new Date(Date.now() - cfg.GC_GRACE_HOURS * 3_600_000);

  const candidates = await prisma.fileObject.findMany({
    where: { refCount: { lte: 0 }, updatedAt: { lt: cutoff } },
    take: GC_BATCH_SIZE,
  });

  const report: StorageGcReport = {
    dryRun: cfg.GC_DRY_RUN,
    scannedAt: new Date().toISOString(),
    candidates: candidates.length,
    ledgerProtected: 0,
    agentProtected: 0,
    unlocatable: 0,
    skipped: 0,
    reclaimed: [],
  };
  if (candidates.length === 0) return report;

  // 账本二次对账：以 file_refs 为准，聚合计数漂移的候选本轮只报告
  const ledgerRows = await prisma.fileRef.findMany({
    where: { hash: { in: candidates.map((c) => c.hash) } },
    select: { userId: true, hash: true },
  });
  const ledgerReferenced = new Set(ledgerRows.map((r) => `${r.userId}:${r.hash}`));

  const reclaimable: Array<{ userId: number; hash: string; key: string; size: number }> = [];
  for (const row of candidates) {
    if (ledgerReferenced.has(`${row.userId}:${row.hash}`)) {
      report.ledgerProtected += 1;
      continue;
    }
    if (await isAgentReferenced(row.hash)) {
      report.agentProtected += 1;
      continue;
    }
    if (!row.ext.startsWith(".")) {
      report.unlocatable += 1;
      continue;
    }

    const key = buildStorageKey(row.userId, row.hash, row.ext);
    reclaimable.push({ userId: row.userId, hash: row.hash, key, size: Number(row.size) });
  }

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

    await localStorage.delete(item.key);
    // backend.delete 会吞掉句柄占用类失败：文件若仍在，只是留下一个
    // 无账本行的孤儿磁盘文件，不影响任何引用，记录留痕即可
    const stat = await localStorage.stat(item.key).catch(() => null);
    if (stat) {
      logEvent("gc", { stage: "file_still_present", key: item.key });
    }
  }

  return report;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const report = await runStorageGc();
    logEvent("gc", {
      stage: "done",
      dryRun: report.dryRun,
      candidates: report.candidates,
      ledgerProtected: report.ledgerProtected,
      agentProtected: report.agentProtected,
      unlocatable: report.unlocatable,
      skipped: report.skipped,
      reclaimed: report.reclaimed.length,
    });
  } catch (err) {
    logEvent("gc", { stage: "failed", error: String(err) });
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
