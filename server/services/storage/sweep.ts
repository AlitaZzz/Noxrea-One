/**
 * 按龄清扫的共享力学（staging 清扫与派生清扫同口径，specs/derived-deletion-linkage.md 规则 4）：
 * 判龄（lastModifiedMs 缺失视为未到期，宁可多留一轮不误删在途对象）、
 * dry-run 只统计不删除（storage.gc_dry_run 护栏由调用方读入传入）、
 * 单条删除失败留痕不中断本根（下一周期自然重试）。
 * 枚举失败上抛——阶段失败可见性归调用方（GC 结果字段 / CLI 退出码），
 * 根间隔离粒度归策略侧（派生四根逐根隔离见 derived-cleanup）。
 * 策略（根清单与 TTL）各归其主：派生在 derived-cleanup、staging 在 upload-direct。
 */

import { logger } from "@server/core/logger";
import type { StorageBackend } from "./backend";

/** 枚举 prefix 下超龄对象并逐个删除（dry-run 只统计）；枚举失败上抛，返回实删/应删总数 */
export async function sweepAgedPrefix(
  backend: StorageBackend,
  prefix: string,
  cutoffMs: number,
  dryRun: boolean,
): Promise<number> {
  const entries = await backend.list(prefix);
  let swept = 0;
  for (const entry of entries) {
    if (entry.lastModifiedMs <= 0 || entry.lastModifiedMs >= cutoffMs) continue;
    if (dryRun) {
      swept += 1;
      continue;
    }
    try {
      await backend.delete(entry.key);
      swept += 1;
    } catch (err) {
      logger.warn({ err, prefix, key: entry.key }, "aged sweep delete failed; will retry next cycle");
    }
  }
  return swept;
}
