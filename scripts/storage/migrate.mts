/**
 * 存储对象迁移（specs/storage-s3-backend.md 业务规则 11 / 切换与回滚流程专节）。
 * 一次性工具，应用停止后执行（切换流程第 1 步）：迁移期间的任何写入都是迁移盲区。
 *
 * 用法：
 *   npm run storage:migrate -- --direction local-to-s3 [--dry-run] [--state-file <path>] [--report-file <path>]
 *   npm run storage:migrate -- --direction s3-to-local [--dry-run] [...]
 *
 * 行为（详见规格）：
 * - 内容对象（file_objects 全部行）+ 本地派生产物（_cache/_posters/_sprite/_proxy，排除 _tmp）全量搬迁；
 * - 本地 MD5 与 S3 ETag 校验；ETag 不可比对（multipart `-` 后缀 / SSE-KMS/SSE-C 形态）自动降级为
 *   回读重算 SHA256 与 key 内 hash 比对（代码检测降级并告警）；
 * - 断点续跑：进度日志（JSONL）逐对象落盘，重跑幂等；dry-run 只读盘点（不写远端与
 *   续跑日志，盘点报告照常落盘）；
 * - 本地数据全程不删（uploads/ 留作回滚备份）；迁移逻辑零 DB 写入（引导期 schema
 *   迁移与设置播种属标准引导，不属迁移逻辑）；
 *   内容对象校验失败即中止；派生产物（可再生）失败记清单跳过；staging / 未知 key 列出供人工核对。
 *
 * 部分引导（loadConfig → 迁移 → 设置），不复用 bootstrap()：那会清空 _tmp 并挂载 GC 定时器。
 * 存储后端单例不参与：迁移两侧（本地 fs 与 S3 SDK）由本脚本显式组装——ETag 需直读
 * PutObject 响应（StorageBackend.put 无返回值，规格实施修订明确脚本以 SDK 直读）。
 */
import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "@server/core/database/client";
import { bootstrapCliCore } from "./cli-bootstrap.mts";
import { DERIVED_ROOT_PREFIXES } from "@server/services/storage/backend";
import { LocalStorageBackend } from "@server/services/storage/backends/local";
import { S3Backend, applyS3Prefix, createS3Client } from "@server/services/storage/backends/s3";
import { buildStorageKey, missingS3Settings, s3OptionsFromSettings } from "@server/services/storage/service";
import { extOfName, mimeByExt } from "@server/services/storage/mime";
import { writeAtomic } from "@server/services/storage/workspace";
import {
  classifyObjectKey,
  runLocalToS3,
  runS3ToLocal,
  type LocalFsPort,
  type LocalToS3Transport,
  type MigrationDirection,
  type MigrationEntry,
  type MigrationIssue,
  type MigrationRunResult,
  type S3ToLocalTransport,
} from "@server/services/storage/migration";

interface CliArgs {
  direction: MigrationDirection;
  dryRun: boolean;
  stateFile: string;
  reportFile: string;
}

function parseArgs(argv: string[]): CliArgs {
  let direction: MigrationDirection | undefined;
  let dryRun = false;
  let stateFile = "";
  let reportFile = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--direction") {
      const v = argv[++i];
      if (v !== "local-to-s3" && v !== "s3-to-local") {
        throw new Error(`--direction 仅支持 local-to-s3 | s3-to-local，收到：${v}`);
      }
      direction = v;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--state-file") {
      stateFile = argv[++i];
    } else if (a === "--report-file") {
      reportFile = argv[++i];
    } else {
      throw new Error(`未知参数：${a}`);
    }
  }
  if (direction === undefined) {
    throw new Error("缺少 --direction local-to-s3 | s3-to-local");
  }
  return { direction, dryRun, stateFile, reportFile };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log("== 存储对象迁移（specs/storage-s3-backend.md 规则 11）==");
  console.log(`direction=${args.direction} dryRun=${args.dryRun}`);
  console.warn("[前置确认] 应用已停止（切换流程第 1 步）——迁移期间的任何写入都是迁移盲区。");

  // 部分引导（core 三步，与 audit 同源；存储后端单例不参与——脚本直连 S3，与
  // storage.backend 当前值无涉，见模块注释）
  await bootstrapCliCore();

  const s3opts = s3OptionsFromSettings();
  const missing = missingS3Settings();
  if (missing.length > 0) {
    throw new Error(`S3 连接设置缺失：${missing.join(", ")}（与 storage.backend 当前值无涉，脚本直连 S3）`);
  }

  const localBackend = new LocalStorageBackend();
  const s3 = new S3Backend(s3opts);
  // 探测同时确认寻址风格（provider=generic 时由它决定），脚本的裸客户端必须跟随同一结论
  const probe = await s3.probe();
  const addressing = probe.capabilities.addressing;
  const root = localBackend.baseDir;
  const log = (line: string): void => console.log(line);
  log(`local root=${root}`);
  log(`endpoint=${s3opts.endpoint} bucket=${s3opts.bucket} prefix=${s3opts.prefix || "(无)"} `
    + `provider=${probe.provider} addressing=${addressing}`);

  // 本地侧端口：穿越守卫与原子落盘复用 local 后端 / 工作区实现
  const localFs: LocalFsPort = {
    pathOf: (key) => localBackend.resolveLocalPath(key),
    sizeOf: async (key) => (await localBackend.stat(key))?.size ?? null,
    write: (key, write) => writeAtomic(root, key, write),
  };

  // ETag 需直读 PutObject 响应：StorageBackend.put 无返回值，脚本持独立 S3Client
  // （与后端共用 createS3Client：寻址风格跟随探测结论，校验和策略同源）
  const sdkClient = createS3Client(s3opts, addressing);

  /** GetObject → Node Readable 归一化（readBack 与 download 共用同一对象读取入口） */
  const openObject = async (key: string): Promise<Readable> => {
    const res = await sdkClient.send(new GetObjectCommand({
      Bucket: s3opts.bucket,
      Key: applyS3Prefix(s3opts.prefix, key),
    }));
    if (!res.Body) throw new Error("S3 GetObject 空 body：" + key);
    return res.Body instanceof Readable ? res.Body : Readable.fromWeb(res.Body as Parameters<typeof Readable.fromWeb>[0]);
  };

  const journalPath = args.stateFile || path.resolve(root, "..", "storage-migration", `${args.direction}.state.jsonl`);
  const reportFile = args.reportFile || path.resolve(root, "..", "storage-migration", `report-${args.direction}.json`);
  const runOpts = { direction: args.direction, dryRun: args.dryRun, journalPath, log };

  let result: MigrationRunResult;
  if (args.direction === "local-to-s3") {
    const transport: LocalToS3Transport = {
      contentEntries: async () => {
        const rows = await prisma.fileObject.findMany({
          select: { userId: true, hash: true, ext: true, size: true },
        });
        // 单次全树枚举逐对象分类：派生另有通道；staging / 未知 / 孤儿一律列清单，绝不静默丢弃
        const objects = await localBackend.list("");
        const content = rows.map((r) => ({ key: buildStorageKey(r.userId, r.hash, r.ext), size: Number(r.size) }));
        const expected = new Set(content.map((e) => e.key));
        const skipped: MigrationIssue[] = [];
        for (const o of objects) {
          const ns = classifyObjectKey(o.key);
          if (ns === "derived") continue; // 派生产物由 derivedEntries 单独枚举
          if (ns === "staging") skipped.push({ key: o.key, reason: "staging 在途暂存，不迁移" });
          else if (ns === "unknown") skipped.push({ key: o.key, reason: "未知本地对象形态，请人工核对" });
          else if (!expected.has(o.key)) skipped.push({ key: o.key, reason: "本地孤儿对象（DB 无引用），不迁移，交审计处置" });
        }
        return { content, skipped };
      },
      derivedEntries: async () => {
        const parts = await Promise.all(DERIVED_ROOT_PREFIXES.map((prefix) => localBackend.list(prefix)));
        return parts.flat().map(({ key, size }) => ({ key, size }));
      },
      upload: async (key, localPath) => {
        const res = await sdkClient.send(new PutObjectCommand({
          Bucket: s3opts.bucket,
          Key: applyS3Prefix(s3opts.prefix, key),
          Body: createReadStream(localPath),
          ContentLength: (await fs.stat(localPath)).size,
          ContentType: mimeByExt(extOfName(key)),
        }));
        return { etag: res.ETag ?? null };
      },
      readBack: openObject,
      remoteSize: async (key) => (await s3.stat(key))?.size ?? null,
    };
    result = await runLocalToS3(transport, localFs, runOpts);
  } else {
    const transport: S3ToLocalTransport = {
      entries: async () => {
        // DB 对账：content 形态而 DB 无行 = 远端孤儿（审计域），列入清单不回迁
        const rows = await prisma.fileObject.findMany({
          select: { userId: true, hash: true, ext: true, size: true },
        });
        const expected = new Set(rows.map((r) => buildStorageKey(r.userId, r.hash, r.ext)));
        const objects = await s3.list("");
        const content: MigrationEntry[] = [];
        const derived: MigrationEntry[] = [];
        const skipped: MigrationIssue[] = [];
        for (const o of objects) {
          const ns = classifyObjectKey(o.key);
          if (ns === "derived") derived.push({ key: o.key, size: o.size });
          else if (ns === "staging") skipped.push({ key: o.key, reason: "staging 在途暂存，不迁移" });
          else if (ns === "unknown") skipped.push({ key: o.key, reason: "未知 key 形态，请人工核对" });
          else if (!expected.has(o.key)) skipped.push({ key: o.key, reason: "远端孤儿对象（DB 无引用），不回迁，交审计处置" });
          else content.push({ key: o.key, size: o.size });
        }
        return { content, derived, skipped };
      },
      download: async (entry) => openObject(entry.key),
    };
    result = await runS3ToLocal(transport, localFs, runOpts);
  }

  printSummary(result, args.dryRun);

  // 盘点报告两种模式都落盘（dry-run 的产出即预检报告：失败/不可迁移逐条列出，计划搬迁以计数给出）
  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.writeFile(
    reportFile,
    JSON.stringify({ direction: args.direction, dryRun: args.dryRun, journalPath, ...result }, null, 2),
    "utf-8",
  );
  log("报告已写入 " + reportFile);
  if (result.failed.length > 0 || result.derivedFailed.length > 0) {
    console.error("迁移存在失败对象（见报告 failed / derivedFailed），修复后重跑补齐（断点续跑幂等）");
    process.exitCode = 1;
  } else {
    log("迁移完成：全部对象校验通过");
  }
}

function printSummary(result: MigrationRunResult, dryRun: boolean): void {
  const lines = [
    "",
    "[扫描] 内容+派生 " + result.scanned + " / 不可迁移（skipped）" + result.skipped.length,
    "[" + (dryRun ? "计划" : "完成") + "] " + (dryRun ? "计划搬迁" : "搬迁校验通过") + " " + result.transferred
      + "（其中降级校验 " + result.degraded + "）/ 已存在跳过 " + result.skippedDone,
    "[失败] 内容对象 " + result.failed.length + (result.failed.length > 0 ? "（已中止，未搬对象重跑补齐）" : "")
      + " / 派生对象 " + result.derivedFailed.length + (result.derivedFailed.length > 0 ? "（已跳过，可再生）" : ""),
  ];
  for (const f of result.failed) lines.push("  FAIL " + f.key + "：" + f.reason);
  for (const f of result.derivedFailed) lines.push("  DERIVED_SKIP " + f.key + "：" + f.reason);
  for (const s of result.skipped) lines.push("  SKIP " + s.key + "：" + s.reason);
  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error("迁移执行失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
