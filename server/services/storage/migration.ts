/**
 * 存储迁移核心（specs/storage-s3-backend.md 业务规则 11 / 切换与回滚流程）。
 * 职责：对象枚举 → 逐对象搬运与校验 → 断点续跑日志 → 失败清单。
 * 方向两侧的具体 IO 由调用方以传输端口注入（CLI 组装本地 fs 与 S3 SDK），
 * 本模块不依赖 prisma / aws-sdk——校验与续跑逻辑可直接单测。
 *
 * 校验矩阵（规则 11：本地 MD5 与 S3 ETag 比对；ETag==MD5 的前提为单次 PUTObject
 * 且 bucket 未启用 SSE-KMS/SSE-C，前提不满足时降级为 size 比对 + 重读哈希）：
 * - 内容对象（key 即内容 hash）local→s3：ETag 为 32 位 hex ⇒ MD5 比对；否则
 *   （multipart `-` 后缀 / SSE-KMS 形态）降级为回读重算 SHA256 与 key 内 hash 比对；
 * - 派生产物（可再生）：ETag 可比对则 MD5 比对，否则仅远端字节数核对；
 *   失败记清单跳过，不中止；
 * - s3→local：内容对象边写边算 SHA256 与 key 内 hash 比对（最强校验，与落盘同一流）；
 *   派生对象按字节数核对。
 *
 * 安全立场：
 * - 本地数据全程不删：s3→local 对既有同体积文件按内容寻址不变量（同 key 同体积
 *   ⇒ 同内容，local 后端 put 去重同一口径）跳过；体积冲突属数据分歧，记失败清单
 *   中止交人工裁决，绝不覆盖本地既有内容对象；
 * - 迁移逻辑零 DB 写入（file_objects 只读；引导期 schema 迁移与设置播种属标准引导，不属迁移逻辑）；
 * - 内容对象校验失败：实跑即中止（续跑日志保留已完成对象，修复后重跑幂等补齐）；dry-run 盘点收集全部缺口不中止；
 * - staging 前缀（直传在途暂存）不迁移；未知 key 形态列出供人工核对。
 */

import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { hashFromStorageKey, isStorageKey } from "@noxrea/shared/url";
import { DERIVED_ROOT_PREFIXES, STAGING_PREFIX } from "./backend";

export type MigrationDirection = "local-to-s3" | "s3-to-local";
/** 校验方式：etag-md5=ETag 与本地 MD5 比对；readback-sha256=降级回读重算；sha256-key=与 key 内 hash 比对；size=字节数 */
export type VerifyKind = "etag-md5" | "readback-sha256" | "sha256-key" | "size";

export interface MigrationEntry {
  key: string;
  size: number;
}

/** 一条逐对象处置结论：失败（中止/跳过）与不可迁移（staging/孤儿/未知）两族共用形状 */
export interface MigrationIssue {
  key: string;
  reason: string;
}

/**
 * 对象 key 的命名空间分类（迁移两侧枚举分类共用）：content=内容寻址对象（isStorageKey）；
 * derived=派生产物；staging=直传在途暂存；unknown=未知形态（列入清单交人工核对，绝不静默丢弃）。
 */
export function classifyObjectKey(key: string): "content" | "derived" | "staging" | "unknown" {
  if ((DERIVED_ROOT_PREFIXES as readonly string[]).some((p) => key.startsWith(p))) return "derived";
  if (key.startsWith(STAGING_PREFIX)) return "staging";
  return isStorageKey(key) ? "content" : "unknown";
}

export interface LocalToS3Transport {
  /** 内容对象清单（file_objects 行投影）+ 枚举期即知的不可迁移项（本地孤儿等） */
  contentEntries(): Promise<{ content: MigrationEntry[]; skipped: MigrationIssue[] }>;
  /** 本地派生产物清单（_cache/_posters/_sprite/_proxy，_tmp 排除） */
  derivedEntries(): Promise<MigrationEntry[]>;
  /** 上传本地文件；返回响应 ETag（网关不回传时为 null，触发降级校验） */
  upload(key: string, localPath: string): Promise<{ etag: string | null }>;
  /** 降级校验的回读流 */
  readBack(key: string): Promise<Readable>;
  /** 派生产物降级校验的远端体积核对 */
  remoteSize(key: string): Promise<number | null>;
}

export interface S3ToLocalTransport {
  /** 远端全量枚举（已分类；staging / 未知形态随 skipped 带原因列出） */
  entries(): Promise<{
    content: MigrationEntry[];
    derived: MigrationEntry[];
    skipped: MigrationIssue[];
  }>;
  download(entry: MigrationEntry): Promise<Readable>;
}

export interface LocalFsPort {
  /** 存储 key → 本地绝对路径（实现须含穿越守卫） */
  pathOf(key: string): string;
  /** 既有文件体积；不存在为 null */
  sizeOf(key: string): Promise<number | null>;
  /** 原子落盘：写临时文件 → write 内校验通过后由实现 rename 就位，任一步失败清理临时文件 */
  write(key: string, write: (tmpPath: string) => Promise<void>): Promise<void>;
}

export interface MigrationOptions {
  direction: MigrationDirection;
  /** dry-run：只读盘点（核对在位与体积、产出计划清单），不写远端、不写续跑日志 */
  dryRun: boolean;
  /** 断点续跑日志（JSONL，逐对象一行，按 direction 过滤） */
  journalPath: string;
  log?: (line: string) => void;
}

export interface MigrationRunResult {
  scanned: number;
  transferred: number;
  /** 续跑日志 / 既有文件命中而跳过 */
  skippedDone: number;
  /** 降级校验（ETag 不可比对）对象数 */
  degraded: number;
  /** 内容对象失败（中止运行） */
  failed: MigrationIssue[];
  /** 派生产物失败（跳过继续，可再生） */
  derivedFailed: MigrationIssue[];
  /** 不可迁移对象（staging / 本地孤儿 / 未知形态） */
  skipped: MigrationIssue[];
}

interface JournalRecord {
  key: string;
  kind: "content" | "derived";
  verify: VerifyKind;
  bytes: number;
  direction: MigrationDirection;
  at: string;
}

function emptyResult(): MigrationRunResult {
  return { scanned: 0, transferred: 0, skippedDone: 0, degraded: 0, failed: [], derivedFailed: [], skipped: [] };
}

async function loadJournalDone(
  journalPath: string,
  direction: MigrationDirection,
  log: (line: string) => void,
): Promise<Set<string>> {
  const done = new Set<string>();
  let text: string;
  try {
    text = await fs.readFile(journalPath, "utf-8");
  } catch (err) {
    // 无日志 = 首跑；其余读取故障（权限/损坏目录等）上抛——静默当首跑会把全量重搬伪装成正常路径
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return done;
    throw err;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as JournalRecord;
      if (rec.direction === direction && typeof rec.key === "string") done.add(rec.key);
    } catch {
      log(`[续跑] 日志存在无法解析的行，已跳过：${t.slice(0, 80)}`);
    }
  }
  return done;
}

async function appendJournal(journalPath: string, rec: Omit<JournalRecord, "at">): Promise<void> {
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  await fs.appendFile(journalPath, `${JSON.stringify({ ...rec, at: new Date().toISOString() })}\n`, "utf-8");
}

/** 落一条续跑记录；dry-run 只读不写 */
async function record(
  opts: MigrationOptions,
  rec: { key: string; kind: "content" | "derived"; verify: VerifyKind; bytes: number },
): Promise<void> {
  if (opts.dryRun) return;
  await appendJournal(opts.journalPath, { ...rec, direction: opts.direction });
}

/** ETag → 可比对 MD5（32 位 hex）；multipart `-` 后缀与 SSE-KMS/SSE-C 形态返回 null（触发降级） */
export function md5FromEtag(etag: string | null | undefined): string | null {
  if (!etag) return null;
  const hex = etag.replace(/"/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : null;
}

function failReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "本地文件缺失";
  return err instanceof Error ? err.message : String(err);
}

/** 流式哈希本地文件：文件流适配 hashStream（单次读盘，同时得到体积） */
async function hashFile(filePath: string, algo: "md5" | "sha256"): Promise<{ hex: string; bytes: number }> {
  return hashStream(createReadStream(filePath), algo);
}

/** 计数哈希累加器：哈希与字节计数的单一实现（hashStream 与 streamToFileWithHash 共用） */
function createCountingHash(algo: "md5" | "sha256") {
  const hash = createHash(algo);
  let bytes = 0;
  return {
    update(chunk: Buffer): void {
      hash.update(chunk);
      bytes += chunk.length;
    },
    digest(): { hex: string; bytes: number } {
      return { hex: hash.digest("hex"), bytes };
    },
  };
}

/** 流式哈希（无落盘；降级回读校验用） */
async function hashStream(stream: Readable, algo: "md5" | "sha256"): Promise<{ hex: string; bytes: number }> {
  const acc = createCountingHash(algo);
  for await (const chunk of stream) {
    acc.update(chunk as Buffer);
  }
  return acc.digest();
}

/** 边写边算（s3→local 落盘前校验）：下载流 → 计数哈希 Transform → 临时文件，pipeline 统一错误与背压 */
async function streamToFileWithHash(
  stream: Readable,
  tmpPath: string,
  algo: "md5" | "sha256",
): Promise<{ hex: string; bytes: number }> {
  const acc = createCountingHash(algo);
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      acc.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(stream, counter, createWriteStream(tmpPath));
  return acc.digest();
}

/**
 * local → s3：内容对象（DB 行）先行、派生殿后——中止信号来自内容，中止时派生未搬，
 * 重跑按续跑日志幂等补齐。dry-run 只读盘点（在位与体积核对），不产生任何写入。
 */
export async function runLocalToS3(
  t: LocalToS3Transport,
  local: LocalFsPort,
  opts: MigrationOptions,
): Promise<MigrationRunResult> {
  const log = opts.log ?? (() => {});
  const done = await loadJournalDone(opts.journalPath, opts.direction, log);
  const result = emptyResult();

  const { content, skipped } = await t.contentEntries();
  const derived = await t.derivedEntries();
  result.skipped = skipped;
  result.scanned = content.length + derived.length;

  let aborted = false;
  for (const entry of content) {
    if (done.has(entry.key)) {
      result.skippedDone += 1;
      continue;
    }
    const localPath = local.pathOf(entry.key);
    if (opts.dryRun) {
      // 只读盘点：无写入可保护，收集全部缺口（中止是实跑语义）；不写远端 / 不写日志
      const size = await local.sizeOf(entry.key);
      if (size === null) {
        result.failed.push({ key: entry.key, reason: "本地文件缺失" });
        continue;
      }
      if (size !== entry.size) {
        result.failed.push({ key: entry.key, reason: `本地体积 ${size} 与 DB 记录 ${entry.size} 不符` });
        continue;
      }
      result.transferred += 1;
      continue;
    }
    try {
      const localMd5 = await hashFile(localPath, "md5");
      if (localMd5.bytes !== entry.size) {
        result.failed.push({ key: entry.key, reason: `本地体积 ${localMd5.bytes} 与 DB 记录 ${entry.size} 不符` });
        aborted = true;
        break;
      }
      const { etag } = await t.upload(entry.key, localPath);
      const etagMd5 = md5FromEtag(etag);
      if (etagMd5) {
        if (etagMd5 !== localMd5.hex) {
          result.failed.push({ key: entry.key, reason: "S3 ETag 与本地 MD5 不符" });
          aborted = true;
          break;
        }
        result.transferred += 1;
        await record(opts, { key: entry.key, kind: "content", verify: "etag-md5", bytes: localMd5.bytes });
        continue;
      }
      // 降级：ETag 非 32 位 hex（multipart / SSE-KMS/SSE-C）→ 回读重算 SHA256 与 key 内 hash 比对
      log(`[降级] ${entry.key} ETag 不可作 MD5 比对，回读重算 SHA256 校验`);
      const keyHash = hashFromStorageKey(entry.key);
      if (!keyHash) {
        result.failed.push({ key: entry.key, reason: "未知内容 key 形态，无法降级校验" });
        aborted = true;
        break;
      }
      const back = await hashStream(await t.readBack(entry.key), "sha256");
      if (back.hex !== keyHash || back.bytes !== localMd5.bytes) {
        result.failed.push({ key: entry.key, reason: `降级回读校验不符（SHA256/体积）` });
        aborted = true;
        break;
      }
      result.degraded += 1;
      result.transferred += 1;
      await record(opts, { key: entry.key, kind: "content", verify: "readback-sha256", bytes: localMd5.bytes });
    } catch (err) {
      result.failed.push({ key: entry.key, reason: failReason(err) });
      aborted = true;
    }
  }

  if (!aborted) {
    for (const entry of derived) {
      if (done.has(entry.key)) {
        result.skippedDone += 1;
        continue;
      }
      const localPath = local.pathOf(entry.key);
      if (opts.dryRun) {
        const size = await local.sizeOf(entry.key);
        if (size === null) {
          result.derivedFailed.push({ key: entry.key, reason: "本地文件缺失（可再生，已跳过）" });
          continue;
        }
        result.transferred += 1;
        continue;
      }
      try {
        const localMd5 = await hashFile(localPath, "md5");
        const { etag } = await t.upload(entry.key, localPath);
        const etagMd5 = md5FromEtag(etag);
        if (etagMd5 && etagMd5 !== localMd5.hex) {
          result.derivedFailed.push({ key: entry.key, reason: "S3 ETag 与本地 MD5 不符（可再生，已跳过）" });
          continue;
        }
        let verify: VerifyKind = "etag-md5";
        if (!etagMd5) {
          const remote = await t.remoteSize(entry.key);
          if (remote !== localMd5.bytes) {
            result.derivedFailed.push({ key: entry.key, reason: remote === null ? "远端体积不可查（HeadObject 失败/对象不存在），无法核对（可再生，已跳过）" : "远端体积与本地不符（可再生，已跳过）" });
            continue;
          }
          result.degraded += 1;
          verify = "size";
        }
        result.transferred += 1;
        await record(opts, { key: entry.key, kind: "derived", verify, bytes: localMd5.bytes });
      } catch (err) {
        // 派生产物可再生：IO 失败记清单跳过，不中止迁移
        result.derivedFailed.push({ key: entry.key, reason: failReason(err) });
      }
    }
  }
  return result;
}

/**
 * s3 → local（回滚反向补迁）：内容对象边下边算 SHA256 与 key 内 hash 比对，
 * 校验通过才原子落盘；派生产物按字节数核对。既有同体积本地文件按内容寻址不变量
 * 跳过（与 local 后端 put 去重同一口径）；内容对象体积冲突记失败中止——绝不覆盖
 * 本地既有内容（本地数据全程不删是回滚可行性的根基）。
 */
export async function runS3ToLocal(
  t: S3ToLocalTransport,
  local: LocalFsPort,
  opts: MigrationOptions,
): Promise<MigrationRunResult> {
  const log = opts.log ?? (() => {});
  const done = await loadJournalDone(opts.journalPath, opts.direction, log);
  const result = emptyResult();

  const { content, derived, skipped } = await t.entries();
  result.skipped = skipped;
  result.scanned = content.length + derived.length;

  let aborted = false;
  for (const entry of content) {
    if (done.has(entry.key)) {
      result.skippedDone += 1;
      continue;
    }
    const keyHash = hashFromStorageKey(entry.key);
    if (!keyHash) {
      result.failed.push({ key: entry.key, reason: "未知内容 key 形态，无法校验" });
      if (opts.dryRun) continue; // 盘点收集全部缺口（中止是实跑语义）
      aborted = true;
      break;
    }
    const existing = await local.sizeOf(entry.key);
    if (existing !== null) {
      if (existing === entry.size) {
        result.skippedDone += 1;
        await record(opts, { key: entry.key, kind: "content", verify: "size", bytes: existing });
        continue;
      }
      result.failed.push({
        key: entry.key,
        reason: `本地已存在同名内容对象但体积不一致（本地 ${existing} / 远端 ${entry.size}），数据分歧需人工裁决，不覆盖本地`,
      });
      if (opts.dryRun) continue; // 盘点收集全部缺口（中止是实跑语义）
      aborted = true;
      break;
    }
    if (opts.dryRun) {
      result.transferred += 1;
      continue;
    }
    try {
      const stream = await t.download(entry);
      await local.write(entry.key, async (tmpPath) => {
        const { hex, bytes } = await streamToFileWithHash(stream, tmpPath, "sha256");
        if (hex !== keyHash) {
          throw new Error("下载内容 SHA256 与 key 内 hash 不符（远端对象损坏或非本内容）");
        }
        if (bytes !== entry.size) {
          throw new Error(`下载数据量 ${bytes} 与远端体积 ${entry.size} 不符`);
        }
      });
      result.transferred += 1;
      await record(opts, { key: entry.key, kind: "content", verify: "sha256-key", bytes: entry.size });
    } catch (err) {
      result.failed.push({ key: entry.key, reason: failReason(err) });
      aborted = true;
    }
  }

  if (!aborted) {
    for (const entry of derived) {
      if (done.has(entry.key)) {
        result.skippedDone += 1;
        continue;
      }
      const existing = await local.sizeOf(entry.key);
      if (existing !== null && existing === entry.size) {
        result.skippedDone += 1;
        await record(opts, { key: entry.key, kind: "derived", verify: "size", bytes: existing });
        continue;
      }
      if (opts.dryRun) {
        result.transferred += 1;
        continue;
      }
      try {
        const stream = await t.download(entry);
        await local.write(entry.key, async (tmpPath) => {
          const { bytes } = await streamToFileWithHash(stream, tmpPath, "md5");
          if (bytes !== entry.size) {
            throw new Error(`下载数据量 ${bytes} 与远端体积 ${entry.size} 不符`);
          }
        });
        result.transferred += 1;
        await record(opts, { key: entry.key, kind: "derived", verify: "size", bytes: entry.size });
      } catch (err) {
        // 派生产物可再生：失败记清单跳过，不中止
        result.derivedFailed.push({ key: entry.key, reason: failReason(err) });
      }
    }
  }
  return result;
}
