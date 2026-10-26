/**
 * 旧版无版本 `_cache/<tier>/` 的一次性清理（specs/canvas-media-resolution-lod.md
 * 规则 8.3 /「部署与迁移」第 2 条）。
 *
 * 这是迁移工具，不是运行期兼容层：当前派生键只识别 `_cache/v2/...`，旧键不会
 * 被解析、枚举或按源删除；服务端全量升级后执行本模块删除旧档位目录，释放存储。
 * 使用独立的旧档位清单，不复用当前（已扩展为 12 档的）档位表，避免漏删历史档位
 * 或误删新档位；后端无关（只消费 list/delete），删除不存在视为成功，重复执行/多实例
 * 并发执行均安全。只碰 `_cache/<旧档位>/`，不触碰 v2、海报、雪碧图、代理、临时区与源文件。
 */

import { logger } from "@server/core/logger";
import type { StorageBackend } from "./backend";

/** 无版本旧目录的 8 个历史档位（冻结清单，禁止随当前档位表演进；本模块私有，无外部消费） */
const LEGACY_RESIZE_WIDTH_TIERS = [64, 112, 200, 300, 320, 400, 480, 1280] as const;

interface LegacyCachePurgeResult {
  /** 枚举到的旧键数 */
  scanned: number;
  /** 成功删除（含不存在）的键数 */
  deleted: number;
  /** 删除失败的键；非空表示需要重试 */
  failed: Array<{ key: string; error: string }>;
  /** 实际清理的旧档位前缀 */
  prefixes: string[];
}

/**
 * 删除旧版无版本档位目录下的全部对象。某个键删除失败会记录并继续，最后返回失败清单；
 * 前缀枚举失败直接上抛（调用方重试整轮）。没有旧对象时返回全 0，幂等。
 */
export async function purgeLegacyResizeCache(
  backend: StorageBackend,
): Promise<LegacyCachePurgeResult> {
  const result: LegacyCachePurgeResult = {
    scanned: 0,
    deleted: 0,
    failed: [],
    prefixes: [],
  };

  for (const tier of LEGACY_RESIZE_WIDTH_TIERS) {
    const prefix = `_cache/${tier}/`;
    const entries = await backend.list(prefix);
    result.prefixes.push(prefix);

    for (const entry of entries) {
      if (!entry.key.startsWith(prefix)) continue;
      result.scanned += 1;
      try {
        // 派生键不触发按源删除联动（listDerivedArtifactKeys 对非内容键短路），
        // 各后端 delete 的「不存在视为成功」语义使重试天然幂等。
        await backend.delete(entry.key);
        result.deleted += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.failed.push({ key: entry.key, error: message });
        logger.warn({ err, key: entry.key }, "legacy resize cache delete failed; will retry");
      }
    }
  }

  return result;
}
