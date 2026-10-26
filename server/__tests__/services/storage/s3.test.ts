/**
 * S3 后端单测：@aws-sdk 命令捕获桩。
 * 覆盖 put（Buffer / 文件路径 / 流暂存）、get（Range / abort）、
 * stat（404 → null）、delete（四命名空间派生联动 + 非 content key 短路）、
 * list（分页 + 前缀剥离）、listCommonPrefixes（Delimiter 版本发现）、
 * presign（epoch 窗口对齐）、copy、probe 与 key 防护。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getSignedUrl: vi.fn(),
  /** 构造 S3Client 时收到的配置（校验和策略、寻址、请求超时） */
  clientConfigs: [] as Array<Record<string, unknown>>,
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
      constructor(public readonly config: Record<string, unknown>) {
        mocks.clientConfigs.push(config);
      }
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

import { S3Backend, applyS3Prefix, normalizeS3Prefix } from "@server/services/storage/backends/s3";
import { StorageTraversalError } from "@server/services/storage/backend";

function makeBackend(prefix = "app", extra: { browserOrigin?: string } = {}): S3Backend {
  return new S3Backend({
    endpoint: "http://minio.local:9000",
    bucket: "noxrea",
    region: "us-east-1",
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "SECRET_TEST",
    provider: "minio",
    prefix,
    signedUrlTtlSeconds: 3600,
    ...extra,
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
  // 带上部署自己的浏览器来源：CORS 探测按真实来源判定，与线上构造口径一致
  backend = makeBackend("app", { browserOrigin: "https://noxrea.example" });
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

  it("绝对路径与含 .. 的路径段 key 抛 StorageTraversalError（与读管线共用同一判定）", async () => {
    await expect(backend.put("/etc/x.png", Buffer.alloc(1))).rejects.toBeInstanceOf(StorageTraversalError);
    await expect(backend.put("a/../b.png", Buffer.alloc(1))).rejects.toBeInstanceOf(StorageTraversalError);
    // 子串形态同样拒绝：命名空间内没有构造器会产出含 `..` 的段，放宽只会给穿越留缝
    await expect(backend.put("a..b.png", Buffer.alloc(1))).rejects.toBeInstanceOf(StorageTraversalError);
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

  it("删除主对象并联动四命名空间派生：精准 shard list + 版本发现，零全前缀扫描（规则 1/2）", async () => {
    mocks.send.mockImplementation((cmd: {
      kind: string;
      input: { Prefix?: string; Delimiter?: string };
    }) => {
      if (cmd.kind !== "list") return Promise.resolve({});
      if (cmd.input.Delimiter === "/") {
        // 版本发现（listCommonPrefixes）
        return Promise.resolve({ CommonPrefixes: [{ Prefix: "app/_posters/v1/" }] });
      }
      const contents: Record<string, Array<{ Key: string }>> = {
        [`app/_cache/v2/64/3/ab/`]: [{ Key: `app/_cache/v2/64/3/ab/${hash}.webp` }],
        [`app/_posters/v1/3/ab/`]: [{ Key: `app/_posters/v1/3/ab/${hash}.webp` }],
        [`app/_sprite/3/ab/`]: [{ Key: `app/_sprite/3/ab/${hash}_c20v2.webp` }],
        [`app/_proxy/3/ab/`]: [{ Key: `app/_proxy/3/ab/${hash}_w480v3.mp4` }],
      };
      return Promise.resolve({ Contents: contents[cmd.input.Prefix ?? ""] ?? [] });
    });

    await backend.delete(key);

    expect(sentCommands().filter(([kind]) => kind === "delete").map(([, input]) => input.Key)).toEqual([
      `app/${key}`,
      `app/_cache/v2/64/3/ab/${hash}.webp`,
      `app/_posters/v1/3/ab/${hash}.webp`,
      `app/_sprite/3/ab/${hash}_c20v2.webp`,
      `app/_proxy/3/ab/${hash}_w480v3.mp4`,
    ]);
    const listInputs = sentCommands()
      .filter(([kind]) => kind === "list")
      .map(([, input]) => input as { Prefix?: string; Delimiter?: string });
    // 零全前缀扫描：内容列举（非 Delimiter）无 "app/_cache/"、无 "app/_posters/"；版本发现恰一次
    expect(
      listInputs.some(
        (i) => i.Delimiter !== "/" && (i.Prefix === "app/_cache/" || i.Prefix === "app/_posters/"),
      ),
    ).toBe(false);
    expect(listInputs.filter((i) => i.Delimiter === "/")).toHaveLength(1);
  });

  it("非内容 key（staging）无派生半边：只删对象，不枚举派生（清扫流量护栏，规则 3）", async () => {
    await backend.delete("staging/3/uuid");
    expect(sentCommands().map(([kind]) => kind)).toEqual(["delete"]);
  });
});

describe("listCommonPrefixes", () => {
  it("Delimiter 列举一层子前缀并剥离统一前缀", async () => {
    mocks.send.mockResolvedValueOnce({
      CommonPrefixes: [{ Prefix: "app/_posters/v1/" }, { Prefix: "app/_posters/v2/" }],
    });
    await expect(backend.listCommonPrefixes("_posters/")).resolves.toEqual([
      "_posters/v1/",
      "_posters/v2/",
    ]);
    const [[kind, input]] = sentCommands();
    expect(kind).toBe("list");
    expect(input).toMatchObject({ Prefix: "app/_posters/", Delimiter: "/" });
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
  it("presignGet：传入窗口时对齐 epoch 边界，expiresIn 只取 TTL，覆写响应头", async () => {
    mocks.getSignedUrl.mockResolvedValue("https://signed.example/get");
    const ttl = 14_400;
    const window = 3600;
    const url = await backend.presignGet("u/ab/h.png", {
      ttlSeconds: ttl,
      windowSeconds: window,
      responseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent("dl.png")}`,
      cacheControl: "private, max-age=14400, immutable",
    });
    expect(url).toBe("https://signed.example/get");
    const [client, cmd, opts] = mocks.getSignedUrl.mock.calls[0];
    expect(cmd.input).toMatchObject({
      Bucket: "noxrea",
      Key: "app/u/ab/h.png",
      ResponseContentType: "image/png",
      ResponseContentDisposition: expect.stringContaining("dl.png"),
      ResponseCacheControl: "private, max-age=14400, immutable",
    });
    // 规则 4.2：签名时刻对齐窗口起点，URL 寿命 = TTL（旧协议 ttl + window 已废止）
    expect(opts.expiresIn).toBe(ttl);
    expect(opts.signingDate.getTime() % (window * 1000)).toBe(0);
    void client;
  });

  it("presignGet：同一窗口内多次调用签出同一签名时间（URL 字节一致的前提）", async () => {
    mocks.getSignedUrl.mockResolvedValue("https://signed.example/get");
    const window = 3600;
    // 窗口内两个不同时刻：对齐后必须落到同一 epoch 边界
    const now = Date.now();
    const windowStart = Math.floor(now / (window * 1000)) * window * 1000;
    const spy = vi.spyOn(Date, "now")
      .mockReturnValueOnce(windowStart + 1_000)
      .mockReturnValueOnce(windowStart + (window * 1000) - 1_000);
    try {
      await backend.presignGet("u/ab/h.png", { ttlSeconds: 3600, windowSeconds: window });
      await backend.presignGet("u/ab/h.png", { ttlSeconds: 3600, windowSeconds: window });
    } finally {
      spy.mockRestore();
    }
    const [[, , first], [, , second]] = mocks.getSignedUrl.mock.calls;
    expect(first.signingDate.getTime()).toBe(windowStart);
    expect(second.signingDate.getTime()).toBe(windowStart);
  });

  it("presignGet：跨窗口边界后签名时间变化（缓存键轮换，符合规则 1.4）", async () => {
    mocks.getSignedUrl.mockResolvedValue("https://signed.example/get");
    const window = 3600;
    const windowStart = Math.floor(Date.now() / (window * 1000)) * window * 1000;
    const spy = vi.spyOn(Date, "now")
      .mockReturnValueOnce(windowStart + (window * 1000) - 1)
      .mockReturnValueOnce(windowStart + (window * 1000));
    try {
      await backend.presignGet("u/ab/h.png", { ttlSeconds: 3600, windowSeconds: window });
      await backend.presignGet("u/ab/h.png", { ttlSeconds: 3600, windowSeconds: window });
    } finally {
      spy.mockRestore();
    }
    const [[, , first], [, , second]] = mocks.getSignedUrl.mock.calls;
    expect(second.signingDate.getTime() - first.signingDate.getTime()).toBe(window * 1000);
  });

  it("presignGet：窗口 0 / 非正整数在签址边界被拒绝（NaN 签名日期不会流入 URL）", async () => {
    await expect(
      backend.presignGet("u/ab/h.png", { ttlSeconds: 60, windowSeconds: 0 }),
    ).rejects.toThrow(/window/);
    await expect(
      backend.presignGet("u/ab/h.png", { ttlSeconds: 0, windowSeconds: 60 }),
    ).rejects.toThrow(/TTL/);
  });

  it("presignGet：不传窗口（能力型凭据）沿用 TTL/4 对齐窗口，有效期不因浏览器缓存方案放大", async () => {
    mocks.getSignedUrl.mockResolvedValue("https://signed.example/get");
    await backend.presignGet("u/ab/h.png");
    const [, , opts] = mocks.getSignedUrl.mock.calls[0];
    const window = Math.ceil(3600 / 4);
    expect(opts.expiresIn).toBe(3600);
    expect(opts.signingDate.getTime() % (window * 1000)).toBe(0);
  });

  it("presignGet：能力凭据的缺省窗口与浏览器读路径窗口相互独立，寿命都等于 TTL", async () => {
    mocks.getSignedUrl.mockResolvedValue("https://signed.example/get");
    await backend.presignGet("u/ab/h.png", { ttlSeconds: 14_400 });
    await backend.presignGet("u/ab/h.png", { ttlSeconds: 14_400, windowSeconds: 3600 });
    const [[, , capability], [, , browser]] = mocks.getSignedUrl.mock.calls;
    // 缺省窗口 ceil(ttl/4) = 3600，此处与显式窗口同值；对齐边界各自成立
    expect(capability.expiresIn).toBe(14_400);
    expect(browser.expiresIn).toBe(14_400);
    expect(capability.signingDate.getTime() % (3600 * 1000)).toBe(0);
    expect(browser.signingDate.getTime() % (3600 * 1000)).toBe(0);
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
});

/**
 * 六项能力探测（specs/storage-provider-portability.md 规则 3）：
 * SDK 命令按 kind 模拟端点，HTTP 回读 / 覆盖头 / 预检由 fetch 桩应答。
 * 写入载荷由 put 捕获，回读与 stat 都以它为基准——探测断言的是「同一份字节」。
 */
describe("probe（六项能力探测）", () => {
  let payload: Buffer;
  let overrideHonored: boolean;
  let corsAllowed: boolean;
  let fetchMock: ReturnType<typeof vi.fn>;

  /** provider=generic：首个候选（virtual）失败后才允许切到 path */
  function makeGeneric(): S3Backend {
    return new S3Backend({
      endpoint: "http://minio.local:9000",
      bucket: "noxrea",
      region: "us-east-1",
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "SECRET_TEST",
      provider: "generic",
      prefix: "app",
      signedUrlTtlSeconds: 3600,
    });
  }

  beforeEach(() => {
    payload = Buffer.alloc(0);
    overrideHonored = true;
    corsAllowed = true;
    fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      // 合规端点按 CORS 回显语义放行：把请求里的 Origin 原样回写
      const origin = new Headers(init?.headers).get("origin") ?? "";
      const cors: Record<string, string> = corsAllowed
        ? { "access-control-allow-origin": origin }
        : {};
      if (init?.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }
      const withOverrides = String(input).includes("overrides=1");
      const headers: Record<string, string> = {
        "content-type": "application/octet-stream",
        date: new Date().toUTCString(),
        "access-control-expose-headers": "Content-Length, Content-Range, Content-Type",
        ...cors,
      };
      if (withOverrides && overrideHonored) {
        headers["content-disposition"] = 'attachment; filename="probe.txt"';
        headers["cache-control"] = "private, max-age=60";
      }
      return new Response(payload, { status: 200, headers });
    });
    vi.stubGlobal("fetch", fetchMock);
    // 第一次预设签（回读）与第二次（覆盖头）用不同 URL 区分应答
    mocks.getSignedUrl
      .mockResolvedValueOnce("https://signed.probe/read")
      .mockResolvedValue("https://signed.probe/read?overrides=1");

    mocks.send.mockImplementation((cmd: { kind: string; input: Record<string, unknown> }) => {
      switch (cmd.kind) {
        case "headBucket":
          return Promise.resolve({});
        case "put":
          payload = cmd.input.Body as Buffer;
          return Promise.resolve({});
        case "get":
          return Promise.resolve({ Body: Readable.from([payload]) });
        case "head":
          return Promise.resolve({ ContentLength: payload.length });
        default:
          return Promise.resolve({});
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("六项全绿：返回能力摘要，探测对象用完即删", async () => {
    const report = await backend.probe();
    expect(report.provider).toBe("minio");
    expect(report.capabilities).toEqual({
      addressing: "path",
      responseOverrides: true,
      browserCors: true,
    });
    expect(Math.abs(report.clockSkewSeconds)).toBeLessThanOrEqual(1);
    expect(report.warnings).toEqual([]);
    // 顺序：HeadBucket → 写 → 读 → stat → 删除
    expect(sentCommands().map(([kind]) => kind)).toEqual(["headBucket", "put", "get", "head", "delete"]);
    // 探测对象落在独立命名空间，接口级 key 不带它
    const putKey = sentCommands().find(([kind]) => kind === "put")![1].Key as string;
    expect(putKey).toMatch(/^app\/_probe\/[0-9a-f-]{36}\.txt$/);
    // 两次预设签：第一次不带任何覆盖头（干净回读，Content-Type 断言才不是同义反复），
    // 第二次带覆盖头（被测对象就是覆盖是否生效）
    const [plain, overrides] = mocks.getSignedUrl.mock.calls.map(
      (call) => (call[1] as { input: Record<string, unknown> }).input,
    );
    expect(plain.ResponseContentType).toBeUndefined();
    expect(plain.ResponseCacheControl).toBeUndefined();
    expect(plain.ResponseContentDisposition).toBeUndefined();
    expect(overrides.ResponseContentDisposition).toBe('attachment; filename="probe.txt"');
    expect(overrides.ResponseCacheControl).toBe("private, max-age=60");
  });

  it("覆盖头不被遵守：能力位 false + warning，不失败", async () => {
    overrideHonored = false;
    const report = await backend.probe();
    expect(report.capabilities.responseOverrides).toBe(false);
    expect(report.warnings.join("|")).toContain("覆盖头探测未通过");
    // 能力位落到后端：此后业务签址不再带覆盖参数
    expect(backend.capabilities().responseOverrides).toBe(false);
    mocks.getSignedUrl.mockClear();
    await backend.presignGet("u/ab/h.png", {
      responseContentDisposition: 'attachment; filename="a.png"',
      cacheControl: "private, max-age=60",
    });
    const cmd = mocks.getSignedUrl.mock.calls[0][1] as { input: Record<string, unknown> };
    expect(cmd.input).toMatchObject({ Bucket: "noxrea", Key: "app/u/ab/h.png" });
    expect(cmd.input.ResponseContentDisposition).toBeUndefined();
    expect(cmd.input.ResponseCacheControl).toBeUndefined();
    expect(cmd.input.ResponseContentType).toBeUndefined();
  });

  it("覆盖头回读的传输层故障：按能力位 false 降级，不构成启动失败", async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "OPTIONS") return new Response(null, { status: 204 });
      if (String(input).includes("overrides=1")) throw new TypeError("fetch failed");
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "application/octet-stream", date: new Date().toUTCString() },
      });
    });

    const report = await backend.probe();
    expect(report.capabilities.responseOverrides).toBe(false);
    expect(report.warnings.join("|")).toContain("请求失败");
    expect(backend.capabilities().responseOverrides).toBe(false);
  });

  it("探测的裸 HTTP 请求都带超时信号（端点黑洞不得把 bootstrap 拖成永久挂起）", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      if (init?.method === "OPTIONS") return new Response(null, { status: 204 });
      return new Response(payload, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          date: new Date().toUTCString(),
          "access-control-allow-origin": "https://probe.noxrea.invalid",
          "access-control-expose-headers": "Content-Length",
        },
      });
    });

    await backend.probe();
    // 回读 + 覆盖头 + 预检：三次裸请求，一个都不能是无超时的 fetch
    expect(signals.length).toBeGreaterThanOrEqual(3);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("CORS 未放行：browserCors=false + warning，探测仍通过", async () => {
    corsAllowed = false;
    const report = await backend.probe();
    expect(report.capabilities.browserCors).toBe(false);
    expect(report.warnings.join("|")).toContain("CORS");
  });

  it("CORS 探测用部署自己的站点来源：白名单式桶只放行真实来源", async () => {
    const siteOrigin = "https://noxrea.example";
    // 桶的白名单只允许真实站点；拿探测专用假域名去问必然得到「未放行」
    corsAllowed = false;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const origin = new Headers(init?.headers).get("origin");
      const cors: Record<string, string> = origin === siteOrigin
        ? { "access-control-allow-origin": origin }
        : {};
      if (init?.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      return new Response(payload, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          date: new Date().toUTCString(),
          "access-control-expose-headers": "Content-Length",
          ...cors,
        },
      });
    });

    const configured = new S3Backend({
      endpoint: "http://minio.local:9000",
      bucket: "noxrea",
      region: "us-east-1",
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "SECRET_TEST",
      provider: "minio",
      prefix: "app",
      signedUrlTtlSeconds: 3600,
      browserOrigin: siteOrigin,
    });
    const report = await configured.probe();
    expect(report.capabilities.browserCors).toBe(true);
    // 配置了公开地址就不该再出现「只能验证通配」那条口径警告
    expect(report.warnings.join("|")).not.toContain("network.public_base_url");
  });

  it("未配置公开地址：CORS 只能用哨兵源验证通配，并输出判定口径警告", async () => {
    const report = await makeBackend().probe();
    expect(report.capabilities.browserCors).toBe(true);
    expect(report.warnings.join("|")).toContain("network.public_base_url");
  });

  it("写失败即启动失败：错误带阶段名与「HeadBucket 已通过」线索，且不含凭据", async () => {
    mocks.send.mockImplementation((cmd: { kind: string }) =>
      cmd.kind === "headBucket"
        ? Promise.resolve({})
        : Promise.reject(Object.assign(new Error("Access Denied"), { $metadata: { httpStatusCode: 403 } })));
    const err = await backend.probe().then(
      () => {
        throw new Error("probe should have failed");
      },
      (e: Error) => e,
    );
    expect(err.message).toContain("probe failed at write");
    expect(err.message).toContain("HeadBucket 已通过");
    expect(err.message).toContain("403");
    expect(err.message).not.toContain("SECRET_TEST");
    // 失败也要尽力删除探测对象
    expect(sentCommands().map(([kind]) => kind)).toContain("delete");
  });

  it("回读字节不一致即启动失败（读写都通过仍可能与写入不一致）", async () => {
    mocks.send.mockImplementation((cmd: { kind: string }) => {
      if (cmd.kind === "headBucket") return Promise.resolve({});
      if (cmd.kind === "put") return Promise.resolve({});
      if (cmd.kind === "get") return Promise.resolve({ Body: Readable.from([Buffer.from("different")]) });
      return Promise.resolve({});
    });
    const err = await backend.probe().then(
      () => {
        throw new Error("probe should have failed");
      },
      (e: Error) => e,
    );
    expect(err.message).toContain("probe failed at read");
  });

  it("时钟偏差超过阈值即启动失败；端点 Date 头缺失只警告", async () => {
    const shifted = new Date(Date.now() + 10 * 60 * 1000).toUTCString();
    fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === "OPTIONS") return new Response(null, { status: 204 });
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "application/octet-stream", date: shifted },
      });
    });
    const clockErr = await backend.probe().then(
      () => {
        throw new Error("probe should have failed");
      },
      (e: Error) => e,
    );
    expect(clockErr.message).toContain("probe failed at clock");

    fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) =>
      init?.method === "OPTIONS"
        ? new Response(null, { status: 204 })
        : new Response(payload, { status: 200, headers: { "content-type": "application/octet-stream" } }));
    const report = await backend.probe();
    expect(report.warnings.join("|")).toContain("Date");
  });

  it("generic：虚拟主机失败后退回 path-style，只用成功的那种寻址", async () => {
    const generic = makeGeneric();
    let seen = 0;
    mocks.send.mockImplementation((cmd: { kind: string; input: Record<string, unknown> }) => {
      if (cmd.kind === "headBucket") {
        seen += 1;
        // 第一次（virtual）不可达，第二次（path）通过
        return seen === 1
          ? Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND"), { name: "ENOTFOUND" }))
          : Promise.resolve({});
      }
      if (cmd.kind === "put") {
        payload = cmd.input.Body as Buffer;
        return Promise.resolve({});
      }
      if (cmd.kind === "get") return Promise.resolve({ Body: Readable.from([payload]) });
      if (cmd.kind === "head") return Promise.resolve({ ContentLength: payload.length });
      return Promise.resolve({});
    });
    const report = await generic.probe();
    expect(report.capabilities.addressing).toBe("path");
    expect(seen).toBe(2);
  });

  it("generic：两种寻址都失败时，错误里包含两种 URL 形态与各自状态", async () => {
    const generic = makeGeneric();
    mocks.send.mockRejectedValue(Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } }));
    const err = await generic.probe().then(
      () => {
        throw new Error("probe should have failed");
      },
      (e: Error) => e,
    );
    // virtual: http://noxrea.minio.local:9000/<key>；path: http://minio.local:9000/noxrea/<key>
    expect(err.message).toContain("http://noxrea.minio.local:9000/<key>");
    expect(err.message).toContain("http://minio.local:9000/noxrea/<key>");
    expect(err.message.match(/HTTP 403/g)).toHaveLength(2);
    expect(err.message).not.toContain("SECRET_TEST");
  });
});

describe("前缀归一化与映射", () => {
  it("首尾斜杠不产生错位 key：映射与构造共用 normalizeS3Prefix 单一实现", () => {
    expect(normalizeS3Prefix("/noxrea/")).toBe("noxrea");
    expect(normalizeS3Prefix("")).toBe("");
    expect(applyS3Prefix("/noxrea/", "3/ab/abc.png")).toBe("noxrea/3/ab/abc.png");
    expect(applyS3Prefix("noxrea", "3/ab/abc.png")).toBe("noxrea/3/ab/abc.png");
    expect(applyS3Prefix("", "3/ab/abc.png")).toBe("3/ab/abc.png");
  });
});

describe("客户端组装", () => {
  it("校验和策略、寻址与请求超时都显式给出（不依赖 SDK 缺省）", () => {
    mocks.clientConfigs.length = 0;
    makeBackend();

    const config = mocks.clientConfigs.at(-1)!;
    expect(config.requestChecksumCalculation).toBe("WHEN_REQUIRED");
    expect(config.responseChecksumValidation).toBe("WHEN_REQUIRED");
    expect(config.forcePathStyle).toBe(true);
    // @smithy 两项缺省都是 0（不限）：端点黑洞会让调用永不返回
    expect(config.requestHandler).toMatchObject({
      connectionTimeout: expect.any(Number),
      socketTimeout: expect.any(Number),
    });
    const handler = config.requestHandler as { connectionTimeout: number; socketTimeout: number };
    expect(handler.connectionTimeout).toBeGreaterThan(0);
    expect(handler.socketTimeout).toBeGreaterThan(0);
  });
});
