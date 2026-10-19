/**
 * 直传双模式单测（specs/storage-s3-backend.md 业务规则 6）：
 * 票据校验与秒传短路、提升前复验（SHA256 / 尺寸 / XML 全量流式判定）、
 * 失败清理边界（复验失败不提升、复制中断清理、落库失败保留对象）、
 * 幂等重复完成与 staging 清扫。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { Readable } from "stream";

const mocks = vi.hoisted(() => ({
  presignPut: vi.fn(),
  copy: vi.fn(),
  stat: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  findUnique: vi.fn(),
  persist: vi.fn(),
  probe: vi.fn(),
  getStorageBackend: vi.fn(),
}));

vi.mock("@server/core/config", () => ({
  getConfig: () => ({
    UPLOAD_DIR: "uploads",
    FFMPEG_PATH: "ffmpeg",
    LOG_LEVEL: "silent",
    ALLOW_INSECURE_SECRETS: true,
  }),
}));
vi.mock("@server/core/database/client", () => ({
  prisma: { fileObject: { findUnique: mocks.findUnique } },
}));
vi.mock("@server/core/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());
vi.mock("@server/services/storage/service", () => ({
  getStorageBackend: mocks.getStorageBackend,
  buildStorageKey: (userId: number, hash: string, ext: string) => `${userId}/${hash.slice(0, 2)}/${hash}${ext}`,
  buildFileUrl: (key: string) => `/api/files/${key}`,
  storedFileView: (file: { userId: number; hash: string; ext: string; size: bigint | number; mimeType: string; width: number | null; height: number | null }) => {
    const key = `${file.userId}/${file.hash.slice(0, 2)}/${file.hash}${file.ext}`;
    return { key, url: `/api/files/${key}`, size: Number(file.size), mime_type: file.mimeType, hash: file.hash, width: file.width, height: file.height };
  },
}));
vi.mock("@server/services/storage/persist", () => ({ persistFileObject: mocks.persist }));
vi.mock("@server/services/storage/media-probe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@server/services/storage/media-probe")>()),
  probeUploadVideo: mocks.probe,
}));

import {
  completeDirectUpload,
  createUploadTicket,
  sweepStagingObjects,
} from "@server/services/storage/upload-direct";
import { resetTestSettings } from "../../helpers/settings";

const USER = 3;
const STAGING = `staging/${USER}/11111111-2222-3333-4444-555555555555`;
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

beforeEach(() => {
  vi.clearAllMocks();
  resetTestSettings({ "upload.max_file_mb": 1, "storage.gc_dry_run": false });
  mocks.getStorageBackend.mockReturnValue({
    presignPut: mocks.presignPut,
    copy: mocks.copy,
    stat: mocks.stat,
    get: mocks.get,
    delete: mocks.delete,
    list: mocks.list,
  });
  mocks.presignPut.mockResolvedValue("https://s3.example/signed-put");
  mocks.copy.mockResolvedValue(undefined);
  mocks.delete.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([]);
  mocks.stat.mockResolvedValue(null);
  mocks.findUnique.mockResolvedValue(null);
  mocks.persist.mockResolvedValue({ width: 10, height: 20, duration: null });
  mocks.probe.mockResolvedValue(undefined);
});

describe("createUploadTicket", () => {
  const input = { hash: sha256("hello"), size: 5, name: "hello.png" };

  it("后端无 presignPut 能力：409 direct_unavailable", async () => {
    mocks.getStorageBackend.mockReturnValue({ list: mocks.list });
    await expect(createUploadTicket(USER, input)).rejects.toMatchObject({
      status: 409,
      code: "upload.direct_unavailable",
    });
  });

  it("超限：413 file_too_large 携带上限", async () => {
    await expect(createUploadTicket(USER, { ...input, size: 2 * 1024 * 1024 })).rejects.toMatchObject({
      status: 413,
      code: "upload.file_too_large",
      ctx: { limit: 1 },
    });
  });

  it("扩展名不受支持：415 unsupported_type", async () => {
    await expect(createUploadTicket(USER, { ...input, name: "evil.exe" })).rejects.toMatchObject({
      status: 415,
      code: "upload.unsupported_type",
    });
  });

  it("无扩展名 + 白名单 MIME：受理，按 MIME 签发 PUT", async () => {
    const result = await createUploadTicket(USER, { ...input, name: "blob", contentType: "image/png" });
    expect(result.duplicate).toBe(false);
    expect(mocks.presignPut.mock.calls[0][1]).toEqual({ contentType: "image/png" });
  });

  it("非白名单 MIME + 白名单扩展名：受理，按扩展名推导 PUT Content-Type（与中转同口径）", async () => {
    const result = await createUploadTicket(USER, { ...input, name: "a.png", contentType: "text/plain" });
    expect(result.duplicate).toBe(false);
    expect(mocks.presignPut.mock.calls[0][1]).toEqual({ contentType: "image/png" });
  });

  it("两侧信号皆缺（无扩展名且 MIME 不在白名单）：415 快速失败", async () => {
    await expect(
      createUploadTicket(USER, { ...input, name: "blob", contentType: "text/plain" }),
    ).rejects.toMatchObject({ status: 415, code: "upload.unsupported_type" });
  });

  it("SVG 以任何信号申报（名字或 MIME）：415，与中转同口径", async () => {
    await expect(
      createUploadTicket(USER, { ...input, name: "vector.svg", contentType: "image/png" }),
    ).rejects.toMatchObject({ status: 415, code: "upload.unsupported_type" });
    await expect(
      createUploadTicket(USER, { ...input, name: "a.png", contentType: "image/svg+xml" }),
    ).rejects.toMatchObject({ status: 415, code: "upload.unsupported_type" });
  });

  it("秒传命中：直接返回既有对象，不签发 staging", async () => {
    mocks.findUnique.mockResolvedValueOnce({
      userId: USER,
      hash: input.hash,
      ext: ".png",
      size: 5n,
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
    const result = await createUploadTicket(USER, input);
    expect(result).toEqual({
      duplicate: true,
      file: {
        key: `${USER}/${input.hash.slice(0, 2)}/${input.hash}.png`,
        url: `/api/files/${USER}/${input.hash.slice(0, 2)}/${input.hash}.png`,
        size: 5,
        mime_type: "image/png",
        hash: input.hash,
        width: 1,
        height: 1,
      },
    });
    expect(mocks.presignPut).not.toHaveBeenCalled();
  });

  it("未命中：签发 staging 预签名 PUT，MIME 白名单外由扩展名推导", async () => {
    const result = await createUploadTicket(USER, input);
    expect(result).toMatchObject({
      duplicate: false,
      upload_url: "https://s3.example/signed-put",
      content_type: "image/png",
    });
    const [stagingKey, opts] = mocks.presignPut.mock.calls[0];
    expect(stagingKey).toMatch(new RegExp(`^staging/${USER}/[0-9a-f-]{36}$`));
    expect(opts).toEqual({ contentType: "image/png" });
  });
});

describe("completeDirectUpload", () => {
  const content = "hello";
  const hash = sha256(content);

  it("staging 归属不符（他人 key / 非法形态）：404 staging_missing 且不触碰存储", async () => {
    await expect(
      completeDirectUpload(USER, { stagingKey: "staging/9/11111111-2222-3333-4444-555555555555", hash, name: "a.png" }),
    ).rejects.toMatchObject({ status: 404, code: "upload.staging_missing" });
    await expect(
      completeDirectUpload(USER, { stagingKey: "3/he/whatever.png", hash, name: "a.png" }),
    ).rejects.toMatchObject({ status: 404, code: "upload.staging_missing" });
    expect(mocks.stat).not.toHaveBeenCalled();
  });

  it("staging 不存在：404 staging_missing", async () => {
    await expect(
      completeDirectUpload(USER, { stagingKey: STAGING, hash, name: "a.png" }),
    ).rejects.toMatchObject({ status: 404, code: "upload.staging_missing" });
  });

  it("staging 超限：413 并删除 staging", async () => {
    mocks.stat.mockResolvedValueOnce({ size: 2 * 1024 * 1024, mtimeMs: 1 });
    await expect(
      completeDirectUpload(USER, { stagingKey: STAGING, hash, name: "a.png" }),
    ).rejects.toMatchObject({ status: 413, code: "upload.file_too_large" });
    expect(mocks.delete).toHaveBeenCalledWith(STAGING);
  });

  it("正常完成：复验通过 → 复制提升 → 落库 → 清 staging", async () => {
    mocks.stat.mockResolvedValueOnce({ size: content.length, mtimeMs: 1 });
    mocks.get.mockResolvedValueOnce(Readable.from([Buffer.from(content)]));

    const result = await completeDirectUpload(USER, { stagingKey: STAGING, hash, name: "a.png" });

    expect(result.file).toEqual({
      key: `${USER}/${hash.slice(0, 2)}/${hash}.png`,
      url: `/api/files/${USER}/${hash.slice(0, 2)}/${hash}.png`,
      size: content.length,
      mime_type: "image/png",
      hash,
      width: 10,
      height: 20,
    });
    expect(mocks.get).toHaveBeenCalledWith(STAGING);
    expect(mocks.copy).toHaveBeenCalledWith(STAGING, `${USER}/${hash.slice(0, 2)}/${hash}.png`);
    expect(mocks.persist).toHaveBeenCalledWith({
      userId: USER,
      hash,
      size: content.length,
      mimeType: "image/png",
      ext: ".png",
      source: "upload",
    });
    expect(mocks.delete).toHaveBeenCalledWith(STAGING);
    // 体检门槛（仅视频）内聚于 probeUploadVideo，由 media-probe.test.ts 在探测缝隙覆盖；
    // 服务层无条件透传 content key（视频用例已断言透传参数）
  });

  it("哈希不符（伪造内容）：422 verify_failed，不提升不落库", async () => {
    mocks.stat.mockResolvedValueOnce({ size: 5, mtimeMs: 1 });
    mocks.get.mockResolvedValueOnce(Readable.from([Buffer.from("world")]));

    await expect(
      completeDirectUpload(USER, { stagingKey: STAGING, hash, name: "a.png" }),
    ).rejects.toMatchObject({ status: 422, code: "upload.verify_failed" });
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("XML 文本（SVG 伪装）：422 verify_failed，不提升不落库", async () => {
    const xml = "<svg xmlns='http://www.w3.org/2000/svg'></svg>";
    const xmlHash = sha256(xml);
    mocks.stat.mockResolvedValueOnce({ size: xml.length, mtimeMs: 1 });
    mocks.get.mockResolvedValueOnce(Readable.from([Buffer.from(xml)]));

    await expect(
      completeDirectUpload(USER, { stagingKey: STAGING, hash: xmlHash, name: "a.png" }),
    ).rejects.toMatchObject({ status: 422, code: "upload.verify_failed" });
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("字节数与 HeadObject 不一致：422 verify_failed", async () => {
    mocks.stat.mockResolvedValueOnce({ size: content.length, mtimeMs: 1 });
    mocks.get.mockResolvedValueOnce(Readable.from([Buffer.from("hello!")]));
    const sixHash = sha256("hello!");

    await expect(
      completeDirectUpload(USER, { stagingKey: STAGING, hash: sixHash, name: "a.png" }),
    ).rejects.toMatchObject({ status: 422, code: "upload.verify_failed" });
  });

  it("超长空白后置 XML（原固定前缀截断会漏判的构造形态）：422 且不提升", async () => {
    const padded = `${" ".repeat(9000)}<svg xmlns='http://www.w3.org/2000/svg'></svg>`;
    const paddedHash = sha256(padded);
    mocks.stat.mockResolvedValueOnce({ size: padded.length, mtimeMs: 1 });
    mocks.get.mockResolvedValueOnce(Readable.from([Buffer.from(padded)]));

    await expect(
      completeDirectUpload(USER, { stagingKey: STAGING, hash: paddedHash, name: "a.png" }),
    ).rejects.toMatchObject({ status: 422, code: "upload.verify_failed" });
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("幂等重复完成：同 hash 已落库时返回既有对象，清 staging 不重复提升", async () => {
    mocks.findUnique.mockResolvedValueOnce({
      userId: USER,
      hash,
      ext: ".png",
      size: BigInt(content.length),
      mimeType: "image/png",
      width: 3,
      height: 4,
    });

    const result = await completeDirectUpload(USER, { stagingKey: STAGING, hash, name: "a.png" });

    expect(result.file).toEqual({
      key: `${USER}/${hash.slice(0, 2)}/${hash}.png`,
      url: `/api/files/${USER}/${hash.slice(0, 2)}/${hash}.png`,
      size: content.length,
      mime_type: "image/png",
      hash,
      width: 3,
      height: 4,
    });
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.delete).toHaveBeenCalledWith(STAGING);
  });

  it("首次成功后丢失响应的重试（staging 已清）：幂等返回既有对象，不再 404", async () => {
    mocks.findUnique.mockResolvedValueOnce({
      userId: USER,
      hash,
      ext: ".png",
      size: BigInt(content.length),
      mimeType: "image/png",
      width: 5,
      height: 6,
    });

    const result = await completeDirectUpload(USER, { stagingKey: STAGING, hash, name: "a.png" });

    expect(result.file).toEqual({
      key: `${USER}/${hash.slice(0, 2)}/${hash}.png`,
      url: `/api/files/${USER}/${hash.slice(0, 2)}/${hash}.png`,
      size: content.length,
      mime_type: "image/png",
      hash,
      width: 5,
      height: 6,
    });
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("复制提升失败：清理可能残留的内容 key 后原样上抛", async () => {
    mocks.stat.mockResolvedValueOnce({ size: content.length, mtimeMs: 1 });
    mocks.get.mockResolvedValueOnce(Readable.from([Buffer.from(content)]));
    mocks.copy.mockRejectedValueOnce(new Error("copy down"));

    await expect(
      completeDirectUpload(USER, { stagingKey: STAGING, hash, name: "a.png" }),
    ).rejects.toThrow("copy down");
    expect(mocks.delete).toHaveBeenCalledWith(`${USER}/${hash.slice(0, 2)}/${hash}.png`);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("落库失败：错误上抛且保留已提升对象（不删除 contentKey）", async () => {
    mocks.stat.mockResolvedValueOnce({ size: content.length, mtimeMs: 1 });
    mocks.get.mockResolvedValueOnce(Readable.from([Buffer.from(content)]));
    mocks.persist.mockRejectedValueOnce(new Error("db down"));

    await expect(
      completeDirectUpload(USER, { stagingKey: STAGING, hash, name: "a.png" }),
    ).rejects.toThrow("db down");
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("source=derived 透传落库（画布派生文件）", async () => {
    mocks.stat.mockResolvedValueOnce({ size: content.length, mtimeMs: 1 });
    mocks.get.mockResolvedValueOnce(Readable.from([Buffer.from(content)]));

    await completeDirectUpload(USER, { stagingKey: STAGING, hash, name: "a.png", source: "derived" });
    expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ source: "derived" }));
  });

  it("视频扩展名：落库后经探测返回 media_warning", async () => {
    const video = Buffer.from("fake-mp4");
    const videoHash = sha256(video);
    mocks.stat.mockResolvedValueOnce({ size: video.length, mtimeMs: 1 });
    mocks.get.mockResolvedValueOnce(Readable.from([video]));
    mocks.probe.mockResolvedValueOnce({ declared: 10, decodable: 5 });

    const result = await completeDirectUpload(USER, {
      stagingKey: STAGING,
      hash: videoHash,
      name: "clip.mp4",
    });
    expect(result.media_warning).toEqual({ declared: 10, decodable: 5 });
    expect(mocks.probe).toHaveBeenCalledWith(`${USER}/${videoHash.slice(0, 2)}/${videoHash}.mp4`, USER);
  });
});

describe("sweepStagingObjects", () => {
  it("仅删除超龄对象；mtime 缺失视为在途", async () => {
    const now = Date.now();
    mocks.list.mockResolvedValueOnce([
      { key: "staging/3/old", size: 1, lastModifiedMs: now - 25 * 3_600_000 },
      { key: "staging/3/new", size: 1, lastModifiedMs: now - 1_000 },
      { key: "staging/3/unknown", size: 1, lastModifiedMs: 0 },
    ]);
    await expect(sweepStagingObjects()).resolves.toBe(1);
    expect(mocks.delete).toHaveBeenCalledTimes(1);
    expect(mocks.delete).toHaveBeenCalledWith("staging/3/old");
  });

  it("单个删除失败不中断清扫", async () => {
    const now = Date.now();
    mocks.list.mockResolvedValueOnce([
      { key: "staging/3/old-a", size: 1, lastModifiedMs: now - 25 * 3_600_000 },
      { key: "staging/3/old-b", size: 1, lastModifiedMs: now - 25 * 3_600_000 },
    ]);
    mocks.delete.mockRejectedValueOnce(new Error("s3 down"));
    await expect(sweepStagingObjects()).resolves.toBe(1);
    expect(mocks.delete).toHaveBeenCalledWith("staging/3/old-b");
  });

  it("gc_dry_run 开启：只统计不删除（与引用回收同一护栏）", async () => {
    resetTestSettings({ "upload.max_file_mb": 1, "storage.gc_dry_run": true });
    const now = Date.now();
    mocks.list.mockResolvedValueOnce([
      { key: "staging/3/old", size: 1, lastModifiedMs: now - 25 * 3_600_000 },
    ]);
    await expect(sweepStagingObjects()).resolves.toBe(1);
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("枚举失败上抛（GC 阶段失败可见：sweepError / CLI 退出码）", async () => {
    mocks.list.mockRejectedValueOnce(new Error("list down"));
    await expect(sweepStagingObjects()).rejects.toThrow("list down");
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});
