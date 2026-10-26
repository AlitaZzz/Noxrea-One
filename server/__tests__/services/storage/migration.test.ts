/**
 * 迁移核心单测（specs/storage-s3-backend.md 规则 11 / 验收「迁移脚本」）：
 * 校验矩阵（ETag=MD5 / 降级回读 SHA256 / s3→local 边写边算）、dry-run 只读不写、
 * 断点续跑幂等、派生失败跳过不中止、本地数据不删（内容冲突不覆盖）。
 * 传输端口注入内存桩；本地侧用真实临时目录 + workspace.writeAtomic（零 vi.mock）。
 */
import { createHash } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAtomic } from "@server/services/storage/workspace";
import {
  classifyObjectKey,
  md5FromEtag,
  runLocalToS3,
  runS3ToLocal,
  type LocalFsPort,
  type LocalToS3Transport,
  type MigrationEntry,
  type MigrationOptions,
  type S3ToLocalTransport,
} from "@server/services/storage/migration";

function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
function md5hex(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

/** 内容 key 构造：内容寻址——key 内嵌真实 SHA256（isStorageKey 严格形态） */
function contentKey(userId: number, content: Buffer): string {
  const hash = sha256hex(content);
  return `${userId}/${hash.slice(0, 2)}/${hash}.png`;
}

describe("migration 核心（规则 11）", () => {
  let root: string;
  let journalDir: string;
  let journalPath: string;
  let localFs: LocalFsPort;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mig-root-"));
    journalDir = await fs.mkdtemp(path.join(os.tmpdir(), "mig-journal-"));
    journalPath = path.join(journalDir, "journal.jsonl");
    localFs = {
      pathOf: (key) => path.resolve(root, key),
      sizeOf: async (key) => (await fs.stat(path.resolve(root, key)).catch(() => null))?.size ?? null,
      write: (key, write) => writeAtomic(root, key, write),
    };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(journalDir, { recursive: true, force: true });
  });

  function opts(over: Partial<MigrationOptions> = {}): MigrationOptions {
    return { direction: "local-to-s3", dryRun: false, journalPath, ...over };
  }

  async function putFile(key: string, content: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(path.resolve(root, key)), { recursive: true });
    await fs.writeFile(path.resolve(root, key), content);
  }

  /** local→s3 内存远端桩：上传记录 key→内容，ETag 默认取真实 MD5（cannedEtag 覆盖指定 key） */
  function fakeLocalToS3(cannedEtag: Record<string, string | null> = {}, readBackCorrupt = false) {
    const uploaded = new Map<string, Buffer>();
    const upload = vi.fn(async (key: string, localPath: string) => {
      const buf = await fs.readFile(localPath);
      uploaded.set(key, buf);
      return { etag: key in cannedEtag ? cannedEtag[key] : md5hex(buf) };
    });
    const readBack = vi.fn(async (key: string) => {
      const buf = uploaded.get(key);
      if (!buf) throw new Error("readBack: 对象未上传");
      return Readable.from(readBackCorrupt ? Buffer.from("tampered") : buf);
    });
    const remoteSize = vi.fn(async (key: string) => uploaded.get(key)?.length ?? null);
    return { uploaded, upload, readBack, remoteSize };
  }

  function localToS3Transport(
    content: MigrationEntry[],
    derived: MigrationEntry[],
    remote: ReturnType<typeof fakeLocalToS3>,
    skipped: Array<{ key: string; reason: string }> = [],
  ): LocalToS3Transport {
    return {
      contentEntries: async () => ({ content, skipped }),
      derivedEntries: async () => derived,
      upload: remote.upload,
      readBack: remote.readBack,
      remoteSize: remote.remoteSize,
    };
  }

  /** s3→local 内存远端桩：entries 全量枚举，download 按 key 给内容（canned 覆盖可制造损坏） */
  function fakeS3ToLocal(
    content: MigrationEntry[],
    derived: MigrationEntry[],
    blobs: Map<string, Buffer>,
    skipped: Array<{ key: string; reason: string }> = [],
  ) {
    const downloads: string[] = [];
    const download = vi.fn(async (entry: MigrationEntry) => {
      downloads.push(entry.key);
      const buf = blobs.get(entry.key);
      if (!buf) throw new Error("远端对象不存在：" + entry.key);
      return Readable.from(buf);
    });
    const transport: S3ToLocalTransport = {
      entries: async () => ({ content, derived, skipped }),
      download,
    };
    return { transport, download, downloads };
  }

  it("md5FromEtag 分类：32 位 hex 可比对，multipart/KMS 形态降级", () => {
    expect(md5FromEtag('"d41d8cd98f00b204e9800998ecf8427e"')).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5FromEtag("d41d8cd98f00b204e9800998ecf8427e-1")).toBeNull();
    expect(md5FromEtag(null)).toBeNull();
  });

  it("local→s3 全量搬迁：ETag=MD5 校验通过，续跑日志逐对象落盘", async () => {
    const c1 = Buffer.from("hello world");
    const c2 = Buffer.from("second object");
    const k1 = contentKey(3, c1);
    const k2 = contentKey(3, c2);
    const dk = "_cache/v2/320/" + sha256hex(Buffer.from("x")) + ".webp";
    const dc = Buffer.from("derived");
    await putFile(k1, c1);
    await putFile(k2, c2);
    await putFile(dk, dc);
    const remote = fakeLocalToS3();
    const result = await runLocalToS3(
      localToS3Transport(
        [{ key: k1, size: c1.length }, { key: k2, size: c2.length }],
        [{ key: dk, size: dc.length }],
        remote,
      ),
      localFs,
      opts(),
    );
    expect(result.transferred).toBe(3);
    expect(result.degraded).toBe(0);
    expect(result.failed).toHaveLength(0);
    expect(remote.uploaded.get(k1)).toEqual(c1);
    const lines = (await fs.readFile(journalPath, "utf-8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({ key: k1, kind: "content", verify: "etag-md5", direction: "local-to-s3" });
  });

  it("ETag 与本地 MD5 不符：中止，后续对象不搬", async () => {
    const c1 = Buffer.from("a");
    const c2 = Buffer.from("b");
    const k1 = contentKey(3, c1);
    const k2 = contentKey(3, c2);
    await putFile(k1, c1);
    await putFile(k2, c2);
    const remote = fakeLocalToS3({ [k1]: md5hex(Buffer.from("other")) });
    const result = await runLocalToS3(
      localToS3Transport([{ key: k1, size: c1.length }, { key: k2, size: c2.length }], [], remote),
      localFs,
      opts(),
    );
    expect(result.failed).toEqual([{ key: k1, reason: "S3 ETag 与本地 MD5 不符" }]);
    expect(remote.upload).toHaveBeenCalledTimes(1);
    expect(remote.uploaded.has(k2)).toBe(false);
  });

  it("ETag 降级形态（multipart）：回读 SHA256 校验通过并计入 degraded", async () => {
    const c1 = Buffer.from("degradable content");
    const k1 = contentKey(4, c1);
    await putFile(k1, c1);
    const remote = fakeLocalToS3({ [k1]: "d41d8cd98f00b204e9800998ecf8427e-1" });
    const result = await runLocalToS3(
      localToS3Transport([{ key: k1, size: c1.length }], [], remote),
      localFs,
      opts(),
    );
    expect(result.degraded).toBe(1);
    expect(result.transferred).toBe(1);
    expect(result.failed).toHaveLength(0);
    const line = JSON.parse((await fs.readFile(journalPath, "utf-8")).trim());
    expect(line).toMatchObject({ key: k1, verify: "readback-sha256" });
  });

  it("降级回读内容被篡改：中止（回读 SHA256 与 key 不符）", async () => {
    const c1 = Buffer.from("degradable content");
    const k1 = contentKey(4, c1);
    await putFile(k1, c1);
    const remote = fakeLocalToS3({ [k1]: "d41d8cd98f00b204e9800998ecf8427e-1" }, true);
    const result = await runLocalToS3(
      localToS3Transport([{ key: k1, size: c1.length }], [], remote),
      localFs,
      opts(),
    );
    expect(result.failed[0]).toMatchObject({ key: k1 });
    expect(result.failed[0].reason).toContain("降级回读校验不符");
  });

  it("dry-run：不写远端不写日志，仅盘点计划搬迁数", async () => {
    const c1 = Buffer.from("hello world");
    const k1 = contentKey(3, c1);
    const dk = "_cache/v2/320/x.webp";
    await putFile(k1, c1);
    await putFile(dk, Buffer.from("derived"));
    const remote = fakeLocalToS3();
    const result = await runLocalToS3(
      localToS3Transport([{ key: k1, size: c1.length }], [{ key: dk, size: 7 }], remote),
      localFs,
      opts({ dryRun: true }),
    );
    expect(result.transferred).toBe(2);
    expect(remote.upload).not.toHaveBeenCalled();
    await expect(fs.access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("dry-run 本地文件缺失：盘点收集全部缺口不中止，派生盘点继续", async () => {
    const c1 = Buffer.from("hello world");
    const k1 = contentKey(3, c1);
    const k2 = contentKey(3, Buffer.from("second"));
    const dk = "_cache/v2/320/y.webp";
    await putFile(dk, Buffer.from("derived"));
    const remote = fakeLocalToS3();
    const result = await runLocalToS3(
      localToS3Transport([{ key: k1, size: c1.length }, { key: k2, size: 1 }], [{ key: dk, size: 7 }], remote),
      localFs,
      opts({ dryRun: true }),
    );
    expect(result.failed).toEqual([
      { key: k1, reason: "本地文件缺失" },
      { key: k2, reason: "本地文件缺失" },
    ]);
    expect(result.transferred).toBe(1); // 派生照常盘点计入计划
    expect(remote.upload).not.toHaveBeenCalled();
  });

  it("断点续跑：日志命中全部跳过，重跑零上传（幂等）", async () => {
    const c1 = Buffer.from("hello world");
    const k1 = contentKey(3, c1);
    const dk = "_cache/v2/320/x.webp";
    await putFile(k1, c1);
    await putFile(dk, Buffer.from("derived"));
    const first = fakeLocalToS3();
    await runLocalToS3(
      localToS3Transport([{ key: k1, size: c1.length }], [{ key: dk, size: 7 }], first),
      localFs,
      opts(),
    );
    const second = fakeLocalToS3();
    const result = await runLocalToS3(
      localToS3Transport([{ key: k1, size: c1.length }], [{ key: dk, size: 7 }], second),
      localFs,
      opts(),
    );
    expect(result.skippedDone).toBe(2);
    expect(result.transferred).toBe(0);
    expect(second.upload).not.toHaveBeenCalled();
  });

  it("本地孤儿对象（DB 无引用）：列入 skipped，不迁移", async () => {
    const c1 = Buffer.from("hello world");
    const k1 = contentKey(3, c1);
    const orphan = "3/aa/" + sha256hex(Buffer.from("orphan")) + ".png";
    await putFile(k1, c1);
    const remote = fakeLocalToS3();
    const result = await runLocalToS3(
      localToS3Transport([{ key: k1, size: c1.length }], [], remote, [
        { key: orphan, reason: "本地孤儿对象（DB 无引用），不迁移，交审计处置" },
      ]),
      localFs,
      opts(),
    );
    expect(result.skipped).toHaveLength(1);
    expect(remote.uploaded.has(orphan)).toBe(false);
    expect(result.transferred).toBe(1);
  });

  it("local→s3 派生 ETag 不符：记清单跳过，不中止不失败", async () => {
    const c1 = Buffer.from("hello world");
    const k1 = contentKey(3, c1);
    const dk = "_cache/v2/320/x.webp";
    await putFile(k1, c1);
    await putFile(dk, Buffer.from("derived"));
    const remote = fakeLocalToS3({ [dk]: md5hex(Buffer.from("mismatch")) });
    const result = await runLocalToS3(
      localToS3Transport([{ key: k1, size: c1.length }], [{ key: dk, size: 7 }], remote),
      localFs,
      opts(),
    );
    expect(result.failed).toHaveLength(0);
    expect(result.derivedFailed).toEqual([{ key: dk, reason: "S3 ETag 与本地 MD5 不符（可再生，已跳过）" }]);
    expect(result.transferred).toBe(1);
  });

  it("s3→local 全量拉回：SHA256 与 key 校验、派生按体积、staging/未知列入 skipped", async () => {
    const c1 = Buffer.from("pulled back");
    const k1 = contentKey(5, c1);
    const dk = "_cache/v2/64/x.webp";
    const dc = Buffer.from("dstat");
    const blobs = new Map([[k1, c1], [dk, dc]]);
    const { transport, download } = fakeS3ToLocal(
      [{ key: k1, size: c1.length }],
      [{ key: dk, size: dc.length }],
      blobs,
      [
        { key: "staging/3/00000000-0000-4000-8000-000000000000", reason: "staging 在途暂存，不迁移" },
        { key: "unknown-object", reason: "未知 key 形态，请人工核对" },
      ],
    );
    const result = await runS3ToLocal(transport, localFs, opts({ direction: "s3-to-local" }));
    expect(result.transferred).toBe(2);
    expect(result.failed).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(download).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.resolve(root, k1))).toEqual(c1);
    expect(await fs.readFile(path.resolve(root, dk))).toEqual(dc);
  });

  it("s3→local 下载内容被篡改：SHA256 不符中止，不留半截文件", async () => {
    const c1 = Buffer.from("original");
    const k1 = contentKey(5, c1);
    const blobs = new Map([[k1, Buffer.from("tampered bytes")]]);
    const { transport } = fakeS3ToLocal([{ key: k1, size: c1.length }], [], blobs);
    const result = await runS3ToLocal(transport, localFs, opts({ direction: "s3-to-local" }));
    expect(result.failed[0]).toMatchObject({ key: k1 });
    expect(result.failed[0].reason).toContain("SHA256 与 key 内 hash 不符");
    await expect(fs.access(path.resolve(root, k1))).rejects.toMatchObject({ code: "ENOENT" });
    const tmpDir = path.join(root, "_tmp");
    const leftovers = (await fs.readdir(tmpDir).catch(() => [])).length;
    expect(leftovers).toBe(0);
  });

  it("s3→local 既有同体积内容对象：按内容寻址不变量跳过，零下载", async () => {
    const c1 = Buffer.from("already local");
    const k1 = contentKey(5, c1);
    await putFile(k1, c1);
    const blobs = new Map([[k1, c1]]);
    const { transport, download } = fakeS3ToLocal([{ key: k1, size: c1.length }], [], blobs);
    const result = await runS3ToLocal(transport, localFs, opts({ direction: "s3-to-local" }));
    expect(result.skippedDone).toBe(1);
    expect(result.transferred).toBe(0);
    expect(download).not.toHaveBeenCalled();
  });

  it("s3→local 内容对象体积冲突：中止且不覆盖本地（本地数据不删）", async () => {
    const c1 = Buffer.from("original");
    const k1 = contentKey(5, c1);
    const localContent = Buffer.from("diverged content with different length");
    await putFile(k1, localContent);
    const blobs = new Map([[k1, c1]]);
    const { transport } = fakeS3ToLocal([{ key: k1, size: c1.length }], [], blobs);
    const result = await runS3ToLocal(transport, localFs, opts({ direction: "s3-to-local" }));
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toContain("数据分歧需人工裁决");
    expect(await fs.readFile(path.resolve(root, k1))).toEqual(localContent);
  });

  it("s3→local dry-run：冲突列入清单且继续盘点后续对象（收集全部缺口）", async () => {
    const c1 = Buffer.from("original");
    const k1 = contentKey(5, c1);
    const c2 = Buffer.from("second pulled");
    const k2 = contentKey(5, c2);
    await putFile(k1, Buffer.from("diverged content with different length"));
    const blobs = new Map([[k1, c1], [k2, c2]]);
    const { transport, download } = fakeS3ToLocal(
      [{ key: k1, size: c1.length }, { key: k2, size: c2.length }],
      [],
      blobs,
    );
    const result = await runS3ToLocal(transport, localFs, opts({ direction: "s3-to-local", dryRun: true }));
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toContain("数据分歧需人工裁决");
    expect(result.transferred).toBe(1); // k2 在冲突之后仍被盘点
    expect(download).not.toHaveBeenCalled();
  });

  it("s3→local 派生下载失败：记清单跳过，不中止", async () => {
    const c1 = Buffer.from("content");
    const k1 = contentKey(5, c1);
    const dk = "_cache/v2/64/x.webp";
    const blobs = new Map([[k1, c1]]);
    const { transport } = fakeS3ToLocal([{ key: k1, size: c1.length }], [{ key: dk, size: 6 }], blobs);
    const result = await runS3ToLocal(transport, localFs, opts({ direction: "s3-to-local" }));
    expect(result.failed).toHaveLength(0);
    expect(result.derivedFailed[0]).toMatchObject({ key: dk });
    expect(result.transferred).toBe(1);
  });

  it("local→s3 派生降级且远端体积不可查：记失败跳过，不误判为通过", async () => {
    const c1 = Buffer.from("content");
    const k1 = contentKey(6, c1);
    const dk = "_cache/v2/320/x.webp";
    await putFile(k1, c1);
    await putFile(dk, Buffer.from("derived"));
    const remote = fakeLocalToS3({ [dk]: "d41d8cd98f00b204e9800998ecf8427e-1" });
    remote.remoteSize.mockResolvedValue(null); // 刚上传却 HeadObject 不到：不可核对
    const result = await runLocalToS3(
      localToS3Transport([{ key: k1, size: c1.length }], [{ key: dk, size: 7 }], remote),
      localFs,
      opts(),
    );
    expect(result.derivedFailed).toHaveLength(1);
    expect(result.derivedFailed[0].reason).toContain("远端体积不可查");
    expect(result.transferred).toBe(1);
    const lines = (await fs.readFile(journalPath, "utf-8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(1); // 派生未通过校验，不落续跑记录
  });

  it("续跑日志损坏行：跳过该行，其余记录照常命中", async () => {
    const c1 = Buffer.from("hello world");
    const k1 = contentKey(7, c1);
    await putFile(k1, c1);
    const good = JSON.stringify({ key: k1, kind: "content", verify: "etag-md5", bytes: c1.length, direction: "local-to-s3", at: new Date().toISOString() });
    await fs.writeFile(journalPath, good + "\n{{corrupt json\n" + good + "\n", "utf-8");
    const remote = fakeLocalToS3();
    const result = await runLocalToS3(localToS3Transport([{ key: k1, size: c1.length }], [], remote), localFs, opts());
    expect(result.skippedDone).toBe(1);
    expect(result.transferred).toBe(0);
    expect(remote.upload).not.toHaveBeenCalled();
  });

  it("续跑日志按方向过滤：他方向记录不命中本次运行", async () => {
    const c1 = Buffer.from("hello world");
    const k1 = contentKey(7, c1);
    // 本地不预置文件：若预置同体积文件会先命中内容寻址去重，测不到下载路径
    const foreign = JSON.stringify({ key: k1, kind: "content", verify: "etag-md5", bytes: c1.length, direction: "local-to-s3", at: new Date().toISOString() });
    await fs.writeFile(journalPath, foreign + "\n", "utf-8");
    const blobs = new Map([[k1, c1]]);
    const { transport, download } = fakeS3ToLocal([{ key: k1, size: c1.length }], [], blobs);
    const result = await runS3ToLocal(transport, localFs, opts({ direction: "s3-to-local" }));
    expect(result.skippedDone).toBe(0);
    expect(result.transferred).toBe(1);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("classifyObjectKey：内容/派生/staging/未知四类命名空间", () => {
    const hash = sha256hex(Buffer.from("k"));
    expect(classifyObjectKey(`3/${hash.slice(0, 2)}/${hash}.png`)).toBe("content");
    expect(classifyObjectKey("_cache/v2/320/abc.webp")).toBe("derived");
    expect(classifyObjectKey("_posters/v1/abc.webp")).toBe("derived");
    expect(classifyObjectKey("_sprite/abc.jpg")).toBe("derived");
    expect(classifyObjectKey("_proxy/abc.mp4")).toBe("derived");
    expect(classifyObjectKey("staging/3/00000000-0000-4000-8000-000000000000")).toBe("staging");
    expect(classifyObjectKey("unknown-object.bin")).toBe("unknown");
    expect(classifyObjectKey("_tmp/leftover.bin")).toBe("unknown");
  });

  it("续跑日志读取故障（非 ENOENT）上抛：不静默当首跑", async () => {
    const c1 = Buffer.from("hello world");
    const k1 = contentKey(8, c1);
    await putFile(k1, c1);
    await fs.mkdir(journalPath); // journalPath 为目录：readFile 必然故障
    const remote = fakeLocalToS3();
    await expect(
      runLocalToS3(localToS3Transport([{ key: k1, size: c1.length }], [], remote), localFs, opts()),
    ).rejects.toThrow();
    expect(remote.upload).not.toHaveBeenCalled();
  });
});
