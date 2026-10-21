/**
 * 派生产物过期清扫（_cache/_posters/_sprite/_proxy 四根统一，specs/derived-deletion-linkage.md 规则 4）。
 * 挂接 GC 每日周期（runGcCycle 阶段，与引用回收、staging 清扫并列独立成败，路由顺带触发已迁除）；
 * 判龄、gc_dry_run 护栏与删除失败留痕的力学单点在 sweep.ts（与 staging 清扫共享）。
 * 根间失败隔离：单根枚举失败留痕不中断其余根，全部根尝试后聚合上抛——
 * 阶段失败对调用方可见（GcCycleResult.derivedSweepError / CLI 退出码），下一周期自然重试。
 */

import { hoursToMs } from "@server/core/duration";
import { getSetting } from "@server/core/settings";
import { logger } from "@server/core/logger";
import { DERIVED_ROOT_PREFIXES } from "./backend";
import { getStorageBackend } from "./service";
import { sweepAgedPrefix } from "./sweep";

/** 派生按龄清扫：四根逐一回收，返回实删/应删（dry-run）总数；任一根枚举失败则整阶段上抛 */
export async function sweepStaleDerivedObjects(): Promise<number> {
  const backend = getStorageBackend();
  const dryRun = getSetting("storage.gc_dry_run");
  const cutoff = Date.now() - hoursToMs(getSetting("storage.derived_ttl_hours"));
  let swept = 0;
  let firstError: { err: unknown } | null = null;
  for (const prefix of DERIVED_ROOT_PREFIXES) {
    try {
      swept += await sweepAgedPrefix(backend, prefix, cutoff, dryRun);
    } catch (err) {
      logger.warn({ err, prefix }, "derived sweep root failed; will retry next cycle");
      firstError ??= { err };
    }
  }
  if (firstError) throw firstError.err;
  return swept;
}
