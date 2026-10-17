/**
 * 派生产物过期清扫（雪碧图 / 预览代理等按 TTL 重建的缓存对象）。
 * 经后端 list 按前缀枚举 + lastModifiedMs 判龄 + delete 逐个回收；
 * 低频节流（每前缀独立计时），任何失败静默——清扫是顺带维护动作，不阻塞主流程。
 */

import { getStorageBackend } from "./service";

/** 清理扫描的最小间隔：避免每次请求都枚举 */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const lastRunAt = new Map<string, number>();

export async function cleanupStaleDerived(prefix: string, ttlMs: number): Promise<void> {
  const now = Date.now();
  if (now - (lastRunAt.get(prefix) ?? 0) < CLEANUP_INTERVAL_MS) return;
  lastRunAt.set(prefix, now);
  try {
    const backend = getStorageBackend();
    const entries = await backend.list(prefix);
    for (const entry of entries) {
      if (now - entry.lastModifiedMs > ttlMs) {
        await backend.delete(entry.key).catch(() => {});
      }
    }
  } catch {
    // 枚举失败：清理只是顺带做的维护，静默跳过
  }
}
