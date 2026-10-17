/**
 * 全 bucket 审计（specs/storage-s3-backend.md 业务规则 9，低频人工触发）：
 * 存储后端与 file_objects 全量对账，兜底 GC「先删 DB 行后删对象」窗口的
 * 崩溃残留与异常路径孤儿。不作为定时任务（大 bucket 全量 List 昂贵）。
 *
 * 只读：不修改 bucket 与数据库，孤儿 / 缺失清单由人工决定处置。
 * 分类口径：
 * - 主对象（内容寻址 {userId}/{ss}/{hash}{ext}）：bucket 有 DB 无 → 孤儿；
 *   DB 有 bucket 无 → 缺失（引用悬空，最高优先级）；
 * - staging/：直传暂存，超龄（>24h）说明按龄清扫未覆盖，逐条列出；
 * - _cache/_posters/_sprite/_proxy：派生产物，无 DB 行属正常，只计数；
 *   _tmp/：本地工作区临时区，同上；
 * - 其余 key：无法归类的未知对象，逐条列出。
 *
 * 部分引导（loadConfig → 迁移 → 设置 → 存储后端 + 探测），不复用 bootstrap()：
 * 那会清空 _tmp 并挂载 GC 定时器——审计可与运行中服务并行，不得触碰在途临时文件。
 *
 * 用法：npm run storage:audit；发现异常时退出码 1（可脚本化感知）。
 */
import { loadConfig } from "@server/core/config";
import { ensureLocalMigrations, prisma } from "@server/core/database/client";
import { getSetting, initSettings } from "@server/core/settings";
import { isStorageKey } from "@noxrea/shared/url";
import {
  buildStorageKey,
  getStorageBackend,
  initStorageBackend,
} from "@server/services/storage/service";
import { STAGING_MAX_AGE_MS, STAGING_PREFIX } from "@server/services/storage/upload-direct";

/** 派生产物前缀（与 derived-cleanup / 后端 delete 联动的前缀一致） */
const DERIVED_PREFIXES = ["_cache/", "_posters/", "_sprite/", "_proxy/", "_tmp/"] as const;

async function main(): Promise<void> {
  // 与 bootstrap 同序的存储依赖引导（不含 gateway / GC / tmp 清理，见模块注释）
  loadConfig();
  await ensureLocalMigrations();
  await initSettings();
  initStorageBackend();
  await getStorageBackend().probe?.();
  const backend = getStorageBackend();

  const objects = await backend.list("");
  const rows = await prisma.fileObject.findMany({
    select: { userId: true, hash: true, ext: true },
  });
  const expected = new Set(rows.map((r) => buildStorageKey(r.userId, r.hash, r.ext)));

  const orphanMain: string[] = [];
  const missingCandidates: string[] = [];
  const stagingFresh: string[] = [];
  const stagingStale: string[] = [];
  const unknown: string[] = [];
  const derivedCounts: Array<{ prefix: string; count: number }> = DERIVED_PREFIXES.map(
    (prefix) => ({ prefix, count: 0 }),
  );
  const bucketMain = new Set<string>();
  let mainOk = 0;

  const stagingCutoff = Date.now() - STAGING_MAX_AGE_MS;
  for (const obj of objects) {
    if (obj.key.startsWith(STAGING_PREFIX)) {
      // lastModifiedMs 缺失（0）按在途处理：宁可漏报不误报
      (obj.lastModifiedMs > 0 && obj.lastModifiedMs < stagingCutoff ? stagingStale : stagingFresh).push(
        obj.key,
      );
      continue;
    }
    const derived = derivedCounts.find((d) => obj.key.startsWith(d.prefix));
    if (derived) {
      derived.count += 1;
      continue;
    }
    if (isStorageKey(obj.key)) {
      bucketMain.add(obj.key);
      if (expected.has(obj.key)) {
        mainOk += 1;
      } else {
        orphanMain.push(obj.key);
      }
      continue;
    }
    unknown.push(obj.key);
  }
  for (const key of expected) {
    if (!bucketMain.has(key)) missingCandidates.push(key);
  }

  const lines: string[] = [
    `backend=${getSetting("storage.backend")} bucket 对象=${objects.length} file_objects 行=${rows.length}`,
    "",
    `[主对象] 对账一致 ${mainOk}`,
    `[主对象] 孤儿（bucket 有 / DB 无）${orphanMain.length}`,
    ...orphanMain.map((k) => `  ORPHAN ${k}`),
    `[主对象] 缺失（DB 有 / bucket 无）${missingCandidates.length}`,
    ...missingCandidates.map((k) => `  MISSING ${k}`),
    `[staging] 在途 ${stagingFresh.length} / 超龄残留 ${stagingStale.length}`,
    ...stagingStale.map((k) => `  STALE_STAGING ${k}`),
    ...derivedCounts.map((d) => `[派生] ${d.prefix} ${d.count}`),
    `[未知 key] ${unknown.length}`,
    ...unknown.map((k) => `  UNKNOWN ${k}`),
  ];
  console.log(lines.join("\n"));

  const problems = orphanMain.length + missingCandidates.length + stagingStale.length + unknown.length;
  if (problems > 0) {
    console.error(`审计发现 ${problems} 项异常，请人工核对处置清单`);
    process.exitCode = 1;
  } else {
    console.log("审计通过：无孤儿 / 缺失 / 超龄 staging / 未知对象");
  }
}

main().catch((err) => {
  console.error("审计执行失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
