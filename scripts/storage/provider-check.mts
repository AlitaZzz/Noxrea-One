/**
 * provider 一致性检查（specs/storage-provider-portability.md 规则 6.2）。
 *
 * 接入 OSS / COS / R2 等新厂商前、或厂商升级后，用真实凭据手工跑一遍：
 * 依次执行启动探测六项（连通 / 写 / 读 / stat / 预签名回读 / 覆盖头 / CORS）+
 * 一轮更大对象的往返（256KB），逐项输出结果。只读不写业务数据：
 * 全部对象落在 `_probe/` 命名空间，结束时尽力删除。
 *
 * 用法：npm run storage:provider-check
 * 依赖 system_settings 的 `storage.s3.*`（与 storage.backend 当前值无涉）；
 * 致命项失败退出码 1，CORS / 时钟警告只输出不影响退出码（规则 3.5 / 3.6）。
 */
import { randomUUID } from "crypto";

import { S3Backend } from "@server/services/storage/backends/s3";
import { missingS3Settings, s3OptionsFromSettings } from "@server/services/storage/service";
import { bootstrapCliCore } from "./cli-bootstrap.mts";

/** 往返验证载荷：远大于探测的 1KB，覆盖真实读路径的对象尺寸 */
const ROUNDTRIP_BYTES = 256 * 1024;

async function main(): Promise<void> {
  await bootstrapCliCore();

  const missing = missingS3Settings();
  if (missing.length > 0) {
    throw new Error(`S3 连接设置缺失：${missing.join(", ")}`);
  }

  const opts = s3OptionsFromSettings();
  const backend = new S3Backend(opts);
  console.log("== provider 一致性检查（specs/storage-provider-portability.md） ==");
  console.log(`endpoint=${opts.endpoint} bucket=${opts.bucket} prefix=${opts.prefix || "(无)"} provider=${opts.provider}`);

  const startedAt = Date.now();
  const report = await backend.probe();
  const elapsed = Date.now() - startedAt;
  const caps = report.capabilities;

  // 预签名回读是探测致命项：走到这一行说明它已通过，不再单列
  console.log(`\n[PASS] 探测六项（含预签名回读，${elapsed}ms）`);
  console.log(`  寻址风格      ${caps.addressing}`);
  console.log(`  response-*    ${caps.responseOverrides ? "PASS" : "WARN（下载将降级为应用流）"}`);
  console.log(`  浏览器 CORS   ${caps.browserCors ? "PASS" : "WARN（浏览器读图会失败，须配置 bucket CORS）"}`);
  console.log(`  时钟偏差      ${report.clockSkewSeconds}s`);
  for (const warning of report.warnings) console.log(`  [WARN] ${warning}`);

  // 更大对象往返：写 → 回读比对 → stat → 删除（探测之外的尺寸覆盖）
  const key = `_probe/${randomUUID()}.bin`;
  const payload = Buffer.alloc(ROUNDTRIP_BYTES, 0x5a);
  const roundtripStart = Date.now();
  try {
    await backend.put(key, payload);
    const chunks: Buffer[] = [];
    for await (const chunk of await backend.get(key)) chunks.push(chunk as Buffer);
    const readBack = Buffer.concat(chunks);
    if (!readBack.equals(payload)) {
      throw new Error(`回读字节不一致（${readBack.length} vs ${payload.length} 字节）`);
    }
    const stat = await backend.stat(key);
    if (!stat || stat.size !== payload.length) {
      throw new Error(`stat 大小 ${stat?.size ?? "null"}，期望 ${payload.length}`);
    }
    console.log(`\n[PASS] 256KB 往返（写 / 回读 / stat，${Date.now() - roundtripStart}ms）`);
  } finally {
    await backend.delete(key).catch((err: unknown) => {
      console.log(`  [WARN] 检查对象删除失败（残留交存储 GC 处理）：${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // response-* / CORS 未通过时探测已各自写入 warnings（s3.ts probe），这里不再重复计数
  const warnings = report.warnings.length;
  console.log(`\n结论：致命项全部通过${warnings > 0 ? `，${warnings} 项警告见上` : ""}`);
}

main().catch((err: unknown) => {
  console.error(`\n[FAIL] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
