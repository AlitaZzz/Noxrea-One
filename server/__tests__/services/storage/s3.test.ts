/**
 * S3 后端单测：@aws-sdk 命令捕获桩。
 * 覆盖 put（Buffer / 文件路径 / 流暂存）、get（Range / abort）、
 * stat（404 → null）、delete（内容 key 派生联动 + 非 content key 短路）、
 * list（分页 + 前缀剥离）、presign（epoch 窗口对齐）、copy、probe 与 key 防护。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getSignedUrl: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  class CapturedCommand {
    readonly kind: string;
    constructor(
      public input: Record<string, unknown>,
      kind: string,
    ) {
      this.kind = kind;
    }
  }
  const make = (kind: string) =>
    class extends CapturedCommand {
      constructor(input: Record<string, unknown>) {
        super(input, kind);
      }
    };
  return {
    S3Client: class {
      send = mocks.send;
    },
    PutObjectCommand: make("put"),
    GetObjectCommand: make("get"),
    HeadObjectCommand: make("head"),
    HeadBucketCommand: make("headBucket"),
    DeleteObjectCommand: make("delete"),
    ListObjectsV2Command: make("list"),
    CopyObjectCommand: make("copy"),
  };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mocks.getSignedUrl }));

const cfg = vi.hoisted(() => ({ uploadDir: "" }));
vi.mock("@server/core/config", () => ({
  getConfig: () => ({
    UPLOAD_DIR: cfg.uploadDir,
    FFMPEG_PATH: "ffmpeg",
    LOG_LEVEL: "silent",
    ALLOW_INSECURE_SECRETS: true,
  }),
}));

import { S3Backend } from "@server/services/storage/backends/s3";
import { StorageTraversalError } from "@server/services/storage/backend";

function makeBackend(prefix = "app"): S3Backend {
  return new S3Backend({
    endpoint: "http://minio.local:9000",
    bucket: "noxrea",
    region: "us-east-1",
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "SECRET_TEST",
    pathStyle: true,
    prefix,
    signedUrlTtlSeconds: 3600,
  });
}

let backend: S3Backend;

/** 依序取回 send 收到的命令：[kind, input] */
function sentCommands(): Array<[string, Record<string, unknown>]> {
  return mocks.send.mock.calls.map((call) => {
    const cmd = call[0] as { kind: string; input: Record<string, unknown> };
    return [cmd.kind, cmd.input];
  });
}

beforeAll(async () => {
  cfg.uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "s3-backend-"));
});

beforeEach(() => {
  vi.clearAllMocks();
  backend = makeBackend();
});

describe("put", () => {
  it("Buffer：写 Content-Length 与按扩展名推导的 Content-Type，key 带统一前缀", async () => {
    await backend.put("u/ab/hash.png", Buffer.from("hello"));
    const [[kind, input]] = sentCommands();
    expect(kind).toBe("put");
    expect(input).toMatchObject({
      Bucket: "noxrea",
      Key: "app/u/ab/hash.png",
      ContentLength: 5,
      ContentType: "image/png",
    });
  });

  it("文件路径：Content-Length 取自文件大小", async () => {
    const filePath = path.join(cfg.uploadDir, "src-body.bin");
    await fs.writeFile(filePath, Buffer.alloc(7));
    await backend.put("u/ab/hash.bin", filePath);
    const [[kind, input]] = sentCommands();
    expect(kind).toBe("put");
    expect(input).toMatchObject({ Key: "app/u/ab/hash.bin", ContentLength: 7 });
  });

  it("未知长度流：先落工作区 tmp 再上传，上传后清理", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("stream-body"));
        controller.close();
      },
    });
    await backend.put("u/ab/hash2.png", body);
    const [[kind, input]] = sentCommands();
    expect(kind).toBe("put");
    expect(input).toMatchObject({ Key: "app/u/ab/hash2.png", ContentLength: 11 });
    const tmpLeftover = await fs.readdir(path.join(cfg.uploadDir, "_tmp")).catch(() => ["<no-dir>"]);
    expect(tmpLeftover).toEqual([]);
  });

  it("绝对路径与 .. 段 key 抛 StorageTraversalError", async () => {
    await expect(backend.put("/etc/x.png", Buffer.alloc(1))).rejects.toBeInstanceOf(StorageTraversalError);
    await expect(backend.put("a/../b.png", Buffer.alloc(1))).rejects.toBeInstanceOf(StorageTraversalError);
    await expect(backend.stat("../outside.png")).rejects.toBeInstanceOf(StorageTraversalError);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("get", () => {
  it("Range 透传为 bytes=start-，abortSignal 传给 send", async () => {
    const body = Readable.from(["chunk"]);
    mocks.send.mockResolvedValueOnce({ Body: body });
    const controller = new AbortController();
    const stream = await backend.get("u/ab/h.mp4", { range: { start: 5 }, signal: controller.signal });
    expect(stream).toBe(body);
    const [[kind, input]] = sentCommands();
    expect(kind).toBe("get");
    expect(input).toMatchObject({ Key: "app/u/ab/h.mp4", Range: "bytes=5-" });
    expect(mocks.send.mock.calls[0][1]).toEqual({ abortSignal: controller.signal });
  });
});

describe("stat", () => {
  it("HeadObject 映射 size/mtime", async () => {
    mocks.send.mockResolvedValueOnce({ ContentLength: 10, LastModified: new Date(1234) });
    await expect(backend.stat("u/ab/h.png")).resolves.toEqual({
      size: 10,
      mtimeMs: 1234,
    });
  });

  it("NotFound（错误名或 404 状态）收敛为 null，其他错误原样上抛", async () => {
    mocks.send.mockRejectedValueOnce(Object.assign(new Error("nf"), { name: "NotFound" }));
    await expect(backend.stat("u/ab/h.png")).resolves.toBeNull();

    mocks.send.mockRejectedValueOnce(Object.assign(new Error("nf2"), { $metadata: { httpStatusCode: 404 } }));
    await expect(backend.stat("u/ab/h.png")).resolves.toBeNull();

    const boom = new Error("network down");
    mocks.send.mockRejectedValueOnce(boom);
    await expect(backend.stat("u/ab/h.png")).rejects.toBe(boom);
  });
});

describe("delete", () => {
  const hash = "a".repeat(64);
  const key = `3/ab/${hash}.png`;

  it("删除主对象并联动 _cache / _posters 派生（规则 9，内容 key）", async () => {
    mocks.send.mockImplementation((cmd: { kind: string; input: { Prefix?: string } }) => {
      if (cmd.kind === "list") {
        const contents =
          cmd.input.Prefix === "app/_cache/" ? [{ Key: `app/_cache/3/ab/${hash}.webp` }] : [];
        return Promise.resolve({ Contents: contents });
      }
      return Promise.resolve({});
    });
    await backend.delete(key);
    const deletedKeys = sentCommands()
      .filter(([kind]) => kind === "delete")
      .map(([, input]) => input.Key);
    expect(deletedKeys).toEqual([`app/${key}`, `app/_cache/3/ab/${hash}.webp`]);
  });

  it("非内容 key（staging）无派生半边：只删对象，不枚举派生（清扫流量护栏）", async () => {
    await backend.delete("staging/3/uuid");
    expect(sentCommands().map(([kind]) => kind)).toEqual(["delete"]);
  });
});

describe("list", () => {
  it("分页枚举并剥离统一前缀", async () => {
    mocks.send.mockImplementation((cmd: { kind: string; input: { ContinuationToken?: string } }) => {
      if (cmd.input.ContinuationToken === undefined) {
        return Promise.resolve({
          IsTruncated: true,
          NextContinuationToken: "page-2",
          Contents: [{ Key: "app/a.png", Size: 1, LastModified: new Date(0) }],
        });
      }
      return Promise.resolve({
        Contents: [{ Key: "app/b.png", Size: 2, LastModified: new Date(1) }],
      });
    });
    await expect(backend.list("")).resolves.toEqual([
      { key: "a.png", size: 1, lastModifiedMs: 0 },
      { key: "b.png", size: 2, lastModifiedMs: 1 },
    ]);
  });
});

describe("presign", () => {
  it("presignGet：TTL/4 epoch 窗口对齐，expiresIn = ttl + window，覆写响应头", async () => {
    mocks.getSignedUrl.mockResolvedValue("https://signed.example/get");
    const ttl = 800;
    const url = await backend.presignGet("u/ab/h.png", {
      ttlSeconds: ttl,
      responseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent("dl.png")}`,
      cacheControl: "public, max-age=800, immutable",
    });
    expect(url).toBe("https://signed.example/get");
    const [client, cmd, opts] = mocks.getSignedUrl.mock.calls[0];
    expect(cmd.input).toMatchObject({
      Bucket: "noxrea",
      Key: "app/u/ab/h.png",
      ResponseContentType: "image/png",
      ResponseContentDisposition: expect.stringContaining("dl.png"),
      ResponseCacheControl: "public, max-age=800, immutable",
    });
    const window = Math.ceil(ttl / 4);
    expect(opts.expiresIn).toBe(ttl + window);
    expect(opts.signingDate.getTime() % (window * 1000)).toBe(0);
    void client;
  });

  it("presignPut：expiresIn = ttl，透传 ContentType", async () => {
    mocks.getSignedUrl.mockResolvedValue("https://signed.example/put");
    const url = await backend.presignPut("staging/3/uuid", { contentType: "image/png" });
    expect(url).toBe("https://signed.example/put");
    const [, cmd, opts] = mocks.getSignedUrl.mock.calls[0];
    expect(cmd.input).toMatchObject({ Key: "app/staging/3/uuid", ContentType: "image/png" });
    expect(opts.expiresIn).toBe(3600);
  });
});

describe("copy / probe", () => {
  it("copy：CopySource 为 /bucket/URL 编码 key，目标走统一前缀", async () => {
    await backend.copy("u/ab/from a.png", "u/ab/to.png");
    const [[kind, input]] = sentCommands();
    expect(kind).toBe("copy");
    expect(input).toEqual({
      Bucket: "noxrea",
      CopySource: `/noxrea/${encodeURIComponent("app/u/ab/from a.png")}`,
      Key: "app/u/ab/to.png",
    });
  });

  it("probe：HeadBucket 成功即通过；失败抛出含端点/bucket/状态码且不含凭据的错误", async () => {
    mocks.send.mockResolvedValueOnce({});
    await expect(backend.probe()).resolves.toBeUndefined();

    mocks.send.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } }),
    );
    const err = await backend.probe().then(
      () => {
        throw new Error("probe should have failed");
      },
      (e: Error) => e,
    );
    expect(err.message).toContain("minio.local:9000");
    expect(err.message).toContain("noxrea");
    expect(err.message).toContain("403");
    expect(err.message).not.toContain("SECRET_TEST");
    expect(sentCommands()[0][0]).toBe("headBucket");
  });
});
