/**
 * 一次性清理旧版无版本 `_cache/<tier>/` 派生缓存
 * （specs/canvas-media-resolution-lod.md「部署与迁移」第 2 条）。
 *
 * 前置条件：所有服务端实例已升级到 `_cache/v2`。本脚本只删除旧 8 档目录，
 * 不触碰 v2、海报、雪碧图、代理、临时区与源文件；幂等，可重复执行。
 * 属于可再生成的缓存清理，但仍为破坏性操作，执行前需用户明确确认。
 *
 * 用法：npm run storage:purge-legacy-cache
 * 任一枚举失败或存在删除失败键时退出码 1（可重试）。
 */
import { purgeLegacyResizeCache } from "@server/services/storage/cache-migration";
import { getStorageBackend } from "@server/services/storage/service";
import { bootstrapCliStorage } from "./cli-bootstrap.mts";

async function main(): Promise<void> {
  await bootstrapCliStorage();
  const result = await purgeLegacyResizeCache(getStorageBackend());

  console.log(
    [
      `旧档位=${result.prefixes.join(",")}`,
      `扫描=${result.scanned}`,
      `删除=${result.deleted}`,
      `失败=${result.failed.length}`,
    ].join(" | "),
  );
  for (const failure of result.failed) {
    console.error(`DELETE_FAILED ${failure.key}: ${failure.error}`);
  }

  if (result.failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("旧缓存清理失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
