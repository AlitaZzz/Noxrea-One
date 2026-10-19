/**
 * GC 手动触发（specs/storage-s3-backend.md 规则 9）：与进程内定时同一周期实现
 * （引用回收 + staging/派生按龄清扫，gc_dry_run 护栏同口径，runGcCycle 单一来源）。
 *
 * 部分引导经 bootstrapCliStorage（与 audit 同口径，不触碰在途临时文件、不挂定时器）。
 * 并发安全：与运行中服务的 GC 互撞时，事务终检（行已删则跳过）与 backend.delete
 * 的不存在视为成功语义天然幂等。
 *
 * 用法：npm run storage:gc；任一阶段失败退出码 1（可脚本化感知，与 storage:audit 同约定）。
 */
import { getSetting } from "@server/core/settings";
import { runGcCycle } from "@server/services/storage/gc";
import { bootstrapCliStorage } from "./cli-bootstrap.mts";

async function main(): Promise<void> {
  await bootstrapCliStorage();

  const result = await runGcCycle();

  const gc = result.gc;
  if (gc) {
    console.log(
      [
        `dryRun=${gc.dryRun}`,
        `候选=${gc.candidates}`,
        `账本保护=${gc.ledgerProtected}`,
        `Agent 保护=${gc.agentProtected}`,
        `扩展名缺失=${gc.unlocatable}`,
        `终检放弃=${gc.skipped}`,
        `回收=${gc.reclaimed.length}`,
      ].join(" | "),
    );
  }
  console.log(`staging 清扫=${result.swept ?? "失败"}`);
  console.log(`派生清扫=${result.derivedSwept ?? "失败"}`);

  if (result.gcError || result.sweepError || result.derivedSweepError) {
    if (result.gcError) console.error(`引用回收失败：${result.gcError}`);
    if (result.sweepError) console.error(`staging 清扫失败：${result.sweepError}`);
    if (result.derivedSweepError) console.error(`派生清扫失败：${result.derivedSweepError}`);
    process.exit(1);
  }
  console.log(`GC 完成（dryRun=${getSetting("storage.gc_dry_run")}）`);
}

main().catch((err) => {
  console.error("GC 执行失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
