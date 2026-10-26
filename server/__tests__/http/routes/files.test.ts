import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const mocks = vi.hoisted(() => ({
  getResizedWebP: vi.fn(),
  getVideoPosterWebP: vi.fn(),
  authenticate: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());

vi.mock("@server/core/config", () => ({
  getConfig: () => ({
    UPLOAD_DIR: "uploads",
    FFMPEG_PATH: "ffmpeg",
    FFPROBE_PATH: "ffprobe",
    LOG_LEVEL: "silent",
    ALLOW_INSECURE_SECRETS: true,
    JWT_SECRET_KEY: "test-file-route-secret",
  }),
}));

// 缩放两个入口替换为 spy：守卫行为由 media.test.ts 对真实实现验证，
// 这里验证路由层与缩放/校验的协作顺序
vi.mock("@server/services/storage/resize-cache", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@server/services/storage/resize-cache")
  >();
  return {
    ...actual,
    getResizedWebP: mocks.getResizedWebP,
    getVideoPosterWebP: mocks.getVideoPosterWebP,
  };
});

vi.mock("@server/http/middleware/auth", () => ({
  authenticateRequest: mocks.authenticate,
}));

// 归属拒绝审计日志（specs/file-access-ownership.md 业务规则 1/8）以 spy 断言；
// 其余导出保持原实现（同模块的 errText 等被导入链其他模块使用）
vi.mock("@server/core/logger/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@server/core/logger/utils")>()),
  logEvent: mocks.logEvent,
}));

import { Hono } from "hono";

import { metrics } from "@server/core/metrics";
import { router } from "@server/http/routes/files";
import { failCode } from "@server/core/response";
import { jsonBodyLimit } from "@server/http/middleware/body-limit";
import { initStorageBackend } from "@server/services/storage/service";
import { LocalStorageBackend } from "@server/services/storage/backends/local";
import { MediaPoolBusyError } from "@server/services/storage/media-pool";
import { signFileUrlParams } from "@server/services/storage/file-url-signature";
import {
  PRESIGNED_READ_TTL_SECONDS,
  PRESIGNED_READ_WINDOW_SECONDS,
} from "@server/services/storage/signing";
import { FILE_ACCESS_BATCH_LIMIT } from "@noxrea/shared/file-access";

/** 响应头里的附件名（`attachmentDisposition` 的 UTF-8 形态） */
function dispositionName(res: Response): string {
  const header = res.headers.get("Content-Disposition") ?? "";
  return decodeURIComponent(header.split("''")[1] ?? "");
}

/** local 语义 + 预签名能力（描述接口的 signed 分发路由级验证；签名产出为固定假 URL） */
class PresignableLocalBackend extends LocalStorageBackend {
  readonly presignCalls: Array<{ key: string; opts?: Record<string, unknown> }> = [];
  /** 能力位：读路径按它决定覆盖头与下载形态（specs/storage-provider-portability.md 规则 4.2） */
  readonly caps = {
    addressing: "virtual" as const,
    responseOverrides: true,
    browserCors: true,
  };
  capabilities() {
    return { ...this.caps };
  }
  /** 设为 undefined 模拟不支持预签名的 local 后端（stream 分发） */
  presignGet: ((key: string, opts?: Record<string, unknown>) => Promise<string>) | undefined =
    async (key, opts) => {
      this.presignCalls.push({ key, opts });
      return `https://s3.example/get?key=${encodeURIComponent(key)}`;
    };
}

// 归属校验（specs/file-access-ownership.md）要求 key 为严格形态：用户 1 的规范 key
const HASH_A = "ab".repeat(32);
const HASH_B = "cd".repeat(32);
const OWN_KEY = `1/ab/${HASH_A}.png`;
const MISSING_KEY = `1/cd/${HASH_B}.png`;
const OTHER_KEY = `2/ab/${HASH_A}.png`; // 同内容 hash、他人命名空间

let tmpDir = "";
let backend: PresignableLocalBackend;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "files-route-"));
  // stat / 读取流走真实后端（指向隔离根）：穿越与 404 语义由后端自带守卫给出
  backend = new PresignableLocalBackend(tmpDir);
  initStorageBackend(backend);
});

beforeEach(async () => {
  vi.clearAllMocks();
  backend.presignCalls.length = 0;
  backend.caps.responseOverrides = true;
  backend.presignGet = async (key, opts) => {
    backend.presignCalls.push({ key, opts });
    return `https://s3.example/get?key=${encodeURIComponent(key)}`;
  };
  mocks.getResizedWebP.mockResolvedValue(null);
  mocks.getVideoPosterWebP.mockResolvedValue(null);
  // 默认会话凭据：双凭据的拒绝与签名路径由专用 describe 验证
  mocks.authenticate.mockResolvedValue({ user: { id: 1 } });
});

describe("GET /api/files/*", () => {
  it("会话路径下穿越键解析不出属主，归属守卫 404 吸收（信息不外泄）", async () => {
    const res = await router.request("/api/files/..%2Fsecret.png");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("files.file_not_found");
  });

  it("签名路径保留穿越 403（归属守卫不覆盖能力凭据）", async () => {
    mocks.authenticate.mockResolvedValue({
      // 与真实鉴权中间件同源：401 由 failCode 构造（no-store 在构造点单点给出）
      error: failCode(401, "auth.not_authenticated"),
    });
    const { expires, signature } = signFileUrlParams("../secret.png", 60);
    const res = await router.request(`/api/files/..%2Fsecret.png?expires=${expires}&signature=${signature}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("files.invalid_path");
  });

  it("签名路径下绝对形态 key 同样 403（与后端共用同一条形态判定）", async () => {
    mocks.authenticate.mockResolvedValue({
      error: failCode(401, "auth.not_authenticated"),
    });
    const { expires, signature } = signFileUrlParams("/etc/passwd", 60);
    const res = await router.request(
      `/api/files/%2Fetc%2Fpasswd?expires=${expires}&signature=${signature}`,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("files.invalid_path");
  });

  it("畸形百分号编码返回 400，而非未捕获 URIError 变 500", async () => {
    const res = await router.request("/api/files/%zz.png");
    expect(res.status).toBe(400);
  });

  it("staging 未提交缓冲键 → 404（可读键域排除 staging，与 GET/描述路由同源）", async () => {
    const res = await router.request("/api/files/staging/1/123e4567-e89b-12d3-a456-426614174000");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("files.file_not_found");
  });

  it("裸 .. 与 %2e%2e 被 URL 解析器规范化为普通段，最终 404", async () => {
    // WHATWG URL 规范：%2e 视为点段，解析阶段即被消除，无法到达路由检查
    expect((await router.request("/api/files/../secret.png")).status).toBe(404);
    expect((await router.request("/api/files/%2e%2e/secret.png")).status).toBe(
      404
    );
  });

  it("非规范 key（解析不出属主）404，且不触发缩放生成", async () => {
    const res = await router.request("/api/files//etc/x.png?w=100");
    expect(mocks.getResizedWebP).not.toHaveBeenCalled();
    expect(mocks.getVideoPosterWebP).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
  });

  it("缩放产物位于 base 内时放行并返回 webp", async () => {
    const cacheKey = `_cache/v2/100/1/ab/${HASH_A}.webp`;
    await fs.mkdir(path.join(tmpDir, "_cache/v2/100/1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, cacheKey), "x");
    mocks.getResizedWebP.mockResolvedValue(cacheKey);

    const res = await router.request(`/api/files/${OWN_KEY}?w=100`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  // 回归：下载名的扩展名必须取自实际服务的字节（派生读是 .webp），不是请求 key 的扩展名；
  // 否则 `photo.png` 会叠成 `photo.png.webp`（filename 缺省时同理）
  it("派生读的下载名以实际字节扩展名为准，不叠加源扩展名", async () => {
    const cacheKey = `_cache/v2/480/1/ab/${HASH_A}.webp`;
    await fs.mkdir(path.join(tmpDir, "_cache/v2/480/1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, cacheKey), "x");
    mocks.getResizedWebP.mockResolvedValue(cacheKey);

    const withoutName = await router.request(`/api/files/${OWN_KEY}?w=480&download=1`);
    expect(withoutName.status).toBe(200);
    expect(dispositionName(withoutName)).toBe(`${HASH_A}.webp`);

    const withName = await router.request(
      `/api/files/${OWN_KEY}?w=480&download=1&filename=photo.png`,
    );
    expect(dispositionName(withName)).toBe("photo.webp");
  });

  it("文件不存在返回 404", async () => {
    const res = await router.request(`/api/files/${MISSING_KEY}`);
    expect(res.status).toBe(404);
  });

  it("正常文件按扩展名返回 Content-Type", async () => {
    await fs.mkdir(path.join(tmpDir, "1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, OWN_KEY), "x");

    const res = await router.request(`/api/files/${OWN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });
});

describe("GET /api/files/* 归属校验（specs/file-access-ownership.md）", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  /** 他人（用户 2）全部命名空间的对象：beforeAll 落盘、用例遍历，单一清单防漂移 */
  const foreignKeys = [
    OTHER_KEY,
    `staging/2/${uuid}`,
    `_cache/v2/200/2/ab/${HASH_A}.webp`,
    `_posters/v1/2/ab/${HASH_A}.webp`,
    `_sprite/2/ab/${HASH_A}_c20v2.webp`,
    `_proxy/2/ab/${HASH_A}_w480v3.mp4`,
  ];

  beforeAll(async () => {
    // 他人对象（内容/暂存/派生）真实存在：404 只能来自归属拒绝，而非对象缺失
    for (const key of foreignKeys) {
      const abs = path.join(tmpDir, key);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, "x");
    }
  });

  it("他人内容对象 → 404，与不存在对象响应逐字节一致，拒绝写审计日志（user+key）", async () => {
    const denied = await router.request(`/api/files/${OTHER_KEY}`);
    const missing = await router.request(`/api/files/${MISSING_KEY}`);
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe(await missing.text());
    expect(mocks.logEvent).toHaveBeenCalledWith(
      "files",
      expect.objectContaining({ stage: "ownership_denied", userId: 1, key: OTHER_KEY }),
    );
  });

  it("他人 staging / _cache / _posters / 新形态派生 key → 404", async () => {
    for (const key of foreignKeys) {
      const res = await router.request(`/api/files/${key}`);
      expect(res.status, key).toBe(404);
      expect(((await res.json()) as { error: string }).error, key).toBe("files.file_not_found");
    }
  });

  it("会话与签名并存：按会话路径处理，他人 key 的有效签名不放行（规则 2 并存语义）", async () => {
    const { expires, signature } = signFileUrlParams(OTHER_KEY, 60);
    const res = await router.request(
      `/api/files/${OTHER_KEY}?expires=${expires}&signature=${signature}`,
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("files.file_not_found");
  });

  it("旧单向哈希形态派生 key（无内嵌属主）→ 404，前端重调路由自愈", async () => {
    const res = await router.request(`/api/files/_sprite/${"c".repeat(32)}.webp`);
    expect(res.status).toBe(404);
  });

  it("本人 _cache / _posters / 新形态派生 key 放行（staging 不可读，见可读键域用例）", async () => {
    const files: Array<[string, string]> = [
      [`_cache/v2/200/1/ab/${HASH_A}.webp`, "x"],
      [`_posters/v1/1/ab/${HASH_A}.webp`, "x"],
      [`_sprite/1/ab/${HASH_A}_c20v2.webp`, "x"],
      [`_proxy/1/ab/${HASH_A}_w480v3.mp4`, "x"],
    ];
    for (const [key, body] of files) {
      const abs = path.join(tmpDir, key);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body);
      const res = await router.request(`/api/files/${key}`);
      expect(res.status, key).toBe(200);
      expect(await res.text(), key).toBe(body);
    }
  });

  it("派生 key 带 w= 不再派生下一层（派生缓存是终点，防止嵌套放大）", async () => {
    const derived = `_cache/v2/200/1/ab/${HASH_A}.webp`;
    const abs = path.join(tmpDir, derived);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "x");

    const res = await router.request(`/api/files/${derived}?w=960`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("x");
    expect(mocks.getResizedWebP).not.toHaveBeenCalled();
  });

  it("签名路径不叠加归属比对：有效签名放行他人命名空间 key", async () => {
    mocks.authenticate.mockResolvedValue({
      // 与真实鉴权中间件同源：401 由 failCode 构造（no-store 在构造点单点给出）
      error: failCode(401, "auth.not_authenticated"),
    });
    const { expires, signature } = signFileUrlParams(OTHER_KEY, 60);
    const res = await router.request(
      `/api/files/${OTHER_KEY}?expires=${expires}&signature=${signature}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("x");
  });

  it("无权请求不触发缩放生成（守卫先于 w= 分支）", async () => {
    const res = await router.request(`/api/files/${OTHER_KEY}?w=100`);
    expect(res.status).toBe(404);
    expect(mocks.getResizedWebP).not.toHaveBeenCalled();
    expect(mocks.getVideoPosterWebP).not.toHaveBeenCalled();
  });
});

describe("GET /api/files/* Range 请求", () => {
  const rangeKey = `1/ab/${HASH_A}.mp4`;

  beforeEach(async () => {
    // 8 字节文件：Range 边界一目了然
    await fs.mkdir(path.join(tmpDir, "1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, rangeKey), "01234567");
  });

  it("合法区间返回 206 与 Content-Range", async () => {
    const res = await router.request(`/api/files/${rangeKey}`, {
      headers: { Range: "bytes=2-5" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/8");
    expect(res.headers.get("Content-Length")).toBe("4");
    expect(await res.text()).toBe("2345");
  });

  it("start 越界返回 416 并携带通配 Content-Range", async () => {
    const res = await router.request(`/api/files/${rangeKey}`, {
      headers: { Range: "bytes=8-" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */8");
  });

  it("end < start 的畸形区间返回 416，不再产出负长度流", async () => {
    const res = await router.request(`/api/files/${rangeKey}`, {
      headers: { Range: "bytes=5-2" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */8");
  });
});

describe("GET /api/files/* 媒体池过载", () => {
  /** 过载拒绝在 `prepareFileRead` 的 catch 里单点计数：两个出口各计一次，不重不漏 */
  let rejected: MockInstance;

  beforeEach(() => {
    rejected = vi.spyOn(metrics, "mediaBusyRejected");
  });
  afterEach(() => {
    rejected.mockRestore();
  });

  it("图片缩放过载返回 503，不回退原图，指标记一次", async () => {
    await fs.mkdir(path.join(tmpDir, "1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, OWN_KEY), "x");
    mocks.getResizedWebP.mockRejectedValue(new MediaPoolBusyError("sharp", "global", "queue_full"));
    const res = await router.request(`/api/files/${OWN_KEY}?w=100`);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(((await res.json()) as { error: string }).error).toBe("media.busy");
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("视频海报过载返回 503（而非 404）", async () => {
    const rangeKey = `1/ab/${HASH_A}.mp4`;
    await fs.mkdir(path.join(tmpDir, "1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, rangeKey), "01234567");
    mocks.getVideoPosterWebP.mockRejectedValue(new MediaPoolBusyError("ffmpeg_heavy", "global", "wait_timeout"));
    const res = await router.request(`/api/files/${rangeKey}?w=100`);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(((await res.json()) as { error: string }).error).toBe("media.busy");
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("描述接口逐条过载 → 该条 media.busy，整批 200，指标同样只记一次", async () => {
    await fs.mkdir(path.join(tmpDir, "1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, OWN_KEY), "x");
    mocks.getResizedWebP.mockRejectedValue(new MediaPoolBusyError("sharp", "global", "queue_full"));

    const res = await router.request("/api/files/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ key: OWN_KEY, width: 100 }] }),
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: { items: Array<{ key: string; error?: string }> } };
    expect(payload.data.items[0]).toEqual({ key: OWN_KEY, error: "media.busy" });
    expect(rejected).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/files/* 双凭据（spec 规则 6）", () => {
  beforeEach(async () => {
    // 无会话：鉴权失败，只能靠签名凭据放行
    mocks.authenticate.mockResolvedValue({
      // 与真实鉴权中间件同源：401 由 failCode 构造（no-store 在构造点单点给出）
      error: failCode(401, "auth.not_authenticated"),
    });
    await fs.mkdir(path.join(tmpDir, "1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, OWN_KEY), "x");
  });

  it("无会话且无签名 → 401", async () => {
    const res = await router.request(`/api/files/${OWN_KEY}`);
    expect(res.status).toBe(401);
  });

  it("有效签名放行并返回内容", async () => {
    const { expires, signature } = signFileUrlParams(OWN_KEY, 60);
    const res = await router.request(
      `/api/files/${OWN_KEY}?expires=${expires}&signature=${signature}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("x");
  });

  it("过期签名拒绝", async () => {
    const { expires, signature } = signFileUrlParams(OWN_KEY, 0);
    const res = await router.request(
      `/api/files/${OWN_KEY}?expires=${expires}&signature=${signature}`,
    );
    expect(res.status).toBe(401);
  });

  it("篡改签名拒绝", async () => {
    const { expires, signature } = signFileUrlParams(OWN_KEY, 60);
    const tampered = signature.slice(0, -1) + (signature.endsWith("a") ? "b" : "a");
    const res = await router.request(
      `/api/files/${OWN_KEY}?expires=${expires}&signature=${tampered}`,
    );
    expect(res.status).toBe(401);
  });

  it("签名与 key 绑定：A 的签名请求 B 拒绝", async () => {
    const { expires, signature } = signFileUrlParams(MISSING_KEY, 60);
    const res = await router.request(
      `/api/files/${OWN_KEY}?expires=${expires}&signature=${signature}`,
    );
    expect(res.status).toBe(401);
  });

  it("会话请求不受签名逻辑影响", async () => {
    mocks.authenticate.mockResolvedValue({ user: { id: 1 } });
    const res = await router.request(`/api/files/${OWN_KEY}`);
    expect(res.status).toBe(200);
  });
});

describe("POST /api/files/access 描述接口（specs/storage-signed-direct-delivery.md）", () => {
  type DescriptorItem = {
    key: string;
    url?: string;
    delivery?: "signed" | "stream";
    expiresAt?: number;
    refreshAt?: number;
    error?: string;
  };
  type Descriptor = { code: number; msg: string; data: { items: DescriptorItem[] } };

  const postAccess = (body: unknown, query = "") =>
    router.request(`/api/files/access${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  /** 单条描述：批量语义（同序同长、逐条成败）由批量用例覆盖 */
  const postItem = async (item: unknown, query = "") => {
    const res = await postAccess({ items: [item] }, query);
    return { res, payload: (await res.json()) as Descriptor };
  };

  beforeEach(async () => {
    await fs.mkdir(path.join(tmpDir, "1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, OWN_KEY), "x");
  });

  it("signed：ok 信封 + 直连 URL + expiresAt/refreshAt，描述响应 no-store 且不外泄 referrer", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { res, payload } = await postItem({ key: OWN_KEY });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");

    expect(payload.code).toBe(200);
    expect(payload.msg).toBe("success");
    expect(payload.data.items).toHaveLength(1);
    const item = payload.data.items[0];
    expect(item.key).toBe(OWN_KEY);
    expect(item.delivery).toBe("signed");
    expect(item.url).toBe(`https://s3.example/get?key=${encodeURIComponent(OWN_KEY)}`);
    expect(item.error).toBeUndefined();
    // 规则 4.2：寿命 = TTL（expiresIn 不叠加窗口），因此 expiresAt ≤ now + TTL
    expect(item.expiresAt).toBeGreaterThan(before);
    expect(item.expiresAt).toBeLessThanOrEqual(before + PRESIGNED_READ_TTL_SECONDS);
    // 规则 4.7：refreshAt 为寿命 80%，严格早于 expiresAt
    expect(item.refreshAt!).toBeLessThan(item.expiresAt!);
    expect(item.refreshAt!).toBeGreaterThan(before);

    // 签名常量写死：TTL 4h、窗口 1h、浏览器缓存寿命 = 窗口寿命
    expect(backend.presignCalls.at(-1)!.opts).toMatchObject({
      ttlSeconds: PRESIGNED_READ_TTL_SECONDS,
      windowSeconds: PRESIGNED_READ_WINDOW_SECONDS,
      cacheControl: `private, max-age=${PRESIGNED_READ_TTL_SECONDS}, immutable`,
    });
  });

  it("download：disposition 签入 URL，且不进浏览器缓存", async () => {
    const { res } = await postItem({ key: OWN_KEY, download: true, filename: "report" });
    expect(res.status).toBe(200);

    const opts = backend.presignCalls.at(-1)!.opts;
    expect(opts?.responseContentDisposition).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("report.png")}`,
    );
    expect(opts?.cacheControl).toBe("private, no-store");
  });

  it("responseOverrides=false：下载降级 stream，普通读取仍走签名直连（不带覆盖参数）", async () => {
    backend.caps.responseOverrides = false;

    // 下载需要一次性附件名：覆盖头不可用 → 应用流
    const download = await postItem({ key: OWN_KEY, download: true, filename: "report" });
    expect(download.payload.data.items[0]).toEqual({
      key: OWN_KEY,
      url: `/api/files/${OWN_KEY}?download=1&filename=report.png`,
      delivery: "stream",
    });

    // 普通读取不需要附件名 → 仍签名，但调用方不再依赖覆盖头
    const plain = await postItem({ key: OWN_KEY });
    expect(plain.payload.data.items[0].delivery).toBe("signed");
    expect(backend.presignCalls.at(-1)!.opts).toMatchObject({
      ttlSeconds: PRESIGNED_READ_TTL_SECONDS,
    });
    expect(backend.presignCalls.at(-1)!.opts?.responseContentDisposition).toBeUndefined();
  });

  it("w：签名派生缓存 key", async () => {
    const cacheKey = `_cache/v2/100/1/ab/${HASH_A}.webp`;
    await fs.mkdir(path.join(tmpDir, "_cache/v2/100/1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, cacheKey), "x");
    mocks.getResizedWebP.mockResolvedValue(cacheKey);

    const { res } = await postItem({ key: OWN_KEY, width: 100 });
    expect(res.status).toBe(200);
    expect(backend.presignCalls.at(-1)!.key).toBe(cacheKey);
  });

  it("stream：local 后端返回应用流式 URL，w/download 参数补齐", async () => {
    backend.presignGet = undefined;

    const { res, payload } = await postItem({
      key: OWN_KEY,
      width: 100,
      download: true,
      filename: "report",
    });
    expect(res.status).toBe(200);
    expect(backend.presignCalls).toHaveLength(0);
    expect(payload.data.items[0]).toEqual({
      key: OWN_KEY,
      url: `/api/files/${OWN_KEY}?w=100&download=1&filename=report.png`,
      delivery: "stream",
    });
  });

  it("派生 key 带 w：stream URL 不携带未生效的宽度（与 GET 管线一致）", async () => {
    backend.presignGet = undefined;
    const derived = `_cache/v2/200/1/ab/${HASH_A}.webp`;
    const abs = path.join(tmpDir, derived);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "x");

    const { payload } = await postItem({ key: derived, width: 960 });
    expect(payload.data.items[0]).toEqual({
      key: derived,
      url: `/api/files/${derived}`,
      delivery: "stream",
    });
    expect(mocks.getResizedWebP).not.toHaveBeenCalled();
  });

  it("stream：未请求派生/下载时不附加查询参数，且无 expiresAt/refreshAt", async () => {
    backend.presignGet = undefined;
    const { payload } = await postItem({ key: OWN_KEY });
    expect(payload.data.items[0]).toEqual({
      key: OWN_KEY,
      url: `/api/files/${OWN_KEY}`,
      delivery: "stream",
    });
  });

  it("单条管线意外故障收敛为该条 files.read_failed：整批仍 200（逐条隔离）", async () => {
    mocks.getResizedWebP.mockRejectedValueOnce(new Error("sharp crashed"));

    const res = await postAccess({
      items: [{ key: OWN_KEY, width: 100 }, { key: MISSING_KEY }],
    });
    const payload = (await res.json()) as Descriptor;

    expect(res.status).toBe(200);
    expect(payload.data.items).toEqual([
      { key: OWN_KEY, error: "files.read_failed" },
      { key: MISSING_KEY, error: "files.file_not_found" },
    ]);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      "files",
      expect.objectContaining({ level: "error", stage: "describe_failed", key: OWN_KEY }),
    );
  });

  it("交付形态判定本身失败也只影响该条：其余条目照常描述（逐条隔离）", async () => {
    // 形态判定在读管线之前执行：后端能力查询抛错时，异常同样必须收敛为该条错误，
    // 而不是从逐条管线逃逸把整批打回 500。下载形态才读能力位，用它触发判定失败。
    const originalCapabilities = backend.capabilities.bind(backend);
    let capabilityCalls = 0;
    const capabilities = vi.spyOn(backend, "capabilities").mockImplementation(() => {
      if (capabilityCalls++ === 0) throw new Error("backend unavailable");
      return originalCapabilities();
    });
    const describeMetric = vi.spyOn(metrics, "fileAccessDescribe");
    try {
      const res = await postAccess({
        items: [{ key: OWN_KEY, download: true }, { key: OWN_KEY }],
      });
      const payload = (await res.json()) as Descriptor;

      expect(res.status).toBe(200);
      expect(payload.data.items[0]).toEqual({ key: OWN_KEY, error: "files.read_failed" });
      expect(payload.data.items[1]).toMatchObject({ key: OWN_KEY, delivery: "signed" });
      // 判定失败时没有可签址后端：错误按应用流形态计数，日志保留原始错误
      expect(describeMetric).toHaveBeenCalledWith("stream", "error");
      expect(mocks.logEvent).toHaveBeenCalledWith(
        "files",
        expect.objectContaining({
          level: "error",
          stage: "describe_failed",
          delivery: "stream",
          error: "backend unavailable",
        }),
      );
    } finally {
      capabilities.mockRestore();
      describeMetric.mockRestore();
    }
  });

  it("批量：逐条独立成败，items 与请求同序同长", async () => {
    const res = await postAccess({
      items: [{ key: OWN_KEY }, { key: OTHER_KEY }, { key: MISSING_KEY }],
    });
    const payload = (await res.json()) as Descriptor;
    expect(res.status).toBe(200);

    const items = payload.data.items;
    expect(items.map((item) => item.key)).toEqual([OWN_KEY, OTHER_KEY, MISSING_KEY]);
    expect(items[0]).toMatchObject({ delivery: "signed" });
    // 他人 key 与对象不存在同响应（规则 2.4），整批仍是 200
    expect(items[1]).toEqual({ key: OTHER_KEY, error: "files.file_not_found" });
    expect(items[2]).toEqual({ key: MISSING_KEY, error: "files.file_not_found" });
    expect(backend.presignCalls.map((call) => call.key)).toEqual([OWN_KEY]);
  });

  it("批量：批内有界并发（6 个席位），单个请求不会一次性打满", async () => {
    let inFlight = 0;
    let peak = 0;
    backend.presignGet = async (key) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return `https://s3.example/get?key=${encodeURIComponent(key)}`;
    };

    const items = Array.from({ length: 12 }, () => ({ key: OWN_KEY }));
    const res = await postAccess({ items });
    const payload = (await res.json()) as Descriptor;
    expect(res.status).toBe(200);
    expect(payload.data.items).toHaveLength(12);
    expect(payload.data.items.every((item) => item.delivery === "signed")).toBe(true);
    expect(peak).toBe(6);
  });

  it("只认会话凭据：查询串中的能力签名不放行（整批 401）", async () => {
    mocks.authenticate.mockResolvedValue({
      // 与真实鉴权中间件同源：401 由 failCode 构造（no-store 在构造点单点给出）
      error: failCode(401, "auth.not_authenticated"),
    });
    const { expires, signature } = signFileUrlParams(OWN_KEY, 60);
    const res = await postAccess(
      { items: [{ key: OWN_KEY }] },
      `?expires=${expires}&signature=${signature}`,
    );
    expect(res.status).toBe(401);
    expect(backend.presignCalls).toHaveLength(0);
  });

  it("他人 key → 该条 error（与对象不存在同响应），不签名", async () => {
    const { res, payload } = await postItem({ key: OTHER_KEY });
    expect(res.status).toBe(200);
    expect(payload.data.items[0]).toEqual({ key: OTHER_KEY, error: "files.file_not_found" });
    expect(backend.presignCalls).toHaveLength(0);
  });

  it("预签名失败 → 该条 error files.signing_failed，不返回半成品描述", async () => {
    backend.presignGet = async () => {
      throw new Error("credential expired");
    };
    const { res, payload } = await postItem({ key: OWN_KEY });
    expect(res.status).toBe(200);
    expect(payload.data.items[0]).toEqual({ key: OWN_KEY, error: "files.signing_failed" });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([
    ["缺 items", { key: OWN_KEY }],
    ["items 不是数组", { items: { key: OWN_KEY } }],
    ["items 为空", { items: [] }],
    ["items 超过上限", {
      items: Array.from({ length: FILE_ACCESS_BATCH_LIMIT + 1 }, () => ({ key: OWN_KEY })),
    }],
    ["缺 key", { items: [{}] }],
    ["key 非字符串", { items: [{ key: 1 }] }],
    ["key 空串", { items: [{ key: "" }] }],
    ["width 非整数", { items: [{ key: OWN_KEY, width: 1.5 }] }],
    ["width 为 0", { items: [{ key: OWN_KEY, width: 0 }] }],
    ["download 非布尔", { items: [{ key: OWN_KEY, download: "1" }] }],
    ["filename 非字符串", { items: [{ key: OWN_KEY, filename: 1 }] }],
    ["数组体", [{ key: OWN_KEY }]],
  ])("请求体非法（%s）→ 400", async (_label, body) => {
    const res = await postAccess(body);
    expect(res.status).toBe(400);
    expect(backend.presignCalls).toHaveLength(0);
  });

  // 畸形 JSON 与字段类型非法是两类错误（规则 2.4）：前者是解析失败，后者是模式校验失败
  it("JSON 畸形 → 400 common.invalid_json，与字段类型非法区分", async () => {
    const res = await router.request("/api/files/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("common.invalid_json");
    expect(backend.presignCalls).toHaveLength(0);
  });

  it.each([
    ["staging 未提交缓冲", "staging/1/123e4567-e89b-12d3-a456-426614174000"],
    ["非托管命名空间", "notes/1/readme.txt"],
    ["派生键版本段错误", `_cache/v1/320/1/ab/${HASH_A}.webp`],
  ])("%s → 该条 error（与对象不存在同响应），不签名", async (_label, key) => {
    const { res, payload } = await postItem({ key });
    expect(res.status).toBe(200);
    expect(payload.data.items[0]).toEqual({ key, error: "files.file_not_found" });
    expect(backend.presignCalls).toHaveLength(0);
  });

  it("派生产物在可读键域内：雪碧图键本人可描述（规则 2.1）", async () => {
    const spriteKey = `_sprite/1/ab/${HASH_A}_c12v2.webp`;
    await fs.mkdir(path.join(tmpDir, "_sprite/1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, spriteKey), "x");

    const { res } = await postItem({ key: spriteKey });
    expect(res.status).toBe(200);
    expect(backend.presignCalls.at(-1)!.key).toBe(spriteKey);
  });

  it("超长 filename 截断到 255 并保留扩展名（与 GET 路径同一规则）", async () => {
    const { res } = await postItem({ key: OWN_KEY, download: true, filename: "x".repeat(400) });
    expect(res.status).toBe(200);
    const disposition = backend.presignCalls.at(-1)!.opts?.responseContentDisposition as string;
    const encoded = disposition.split("''")[1];
    const name = decodeURIComponent(encoded);
    expect(name).toHaveLength(255);
    expect(name.endsWith(".png")).toBe(true);
  });

  // 回归：按码元截断会把代理对劈成孤立代理，encodeURIComponent 抛 URIError → 500。
  // 孤立代理在编码边界归一为 U+FFFD（1 码元），因此这些入参归一后可能不足上限、不再截断。
  it.each([
    ["截断点落在代理对中间", "a".repeat(249) + "😀"],
    ["入参本身含孤立高位代理", "a".repeat(249) + "\uD83D"],
    ["入参本身含孤立低位代理", "a".repeat(249) + "\uDE00"],
  ])("filename %s → 200，附件名 well-formed 且可解码", async (_label, filename) => {
    const { res } = await postItem({ key: OWN_KEY, download: true, filename });
    expect(res.status).toBe(200);
    const disposition = backend.presignCalls.at(-1)!.opts?.responseContentDisposition as string;
    const name = decodeURIComponent(disposition.split("''")[1]);
    expect(name.length).toBeLessThanOrEqual(255);
    expect(name).toBe(name.toWellFormed());
    expect(name.endsWith(".png")).toBe(true);
  });
});

// 体积上限挂在 app 装配层（规则 2.1），路由单测需按 app.ts 的装配方式挂中间件
describe("POST /api/files/access 请求体上限", () => {
  const app = new Hono();
  app.use("/api/files/access", jsonBodyLimit(64 * 1024));
  app.route("/", router);

  it("超过 64KB → 413 common.body_too_large，不进入路由", async () => {
    const res = await app.request("/api/files/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ key: OWN_KEY }], padding: "x".repeat(64 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("common.body_too_large");
    expect(backend.presignCalls).toHaveLength(0);
    // 体积上限在路由之外（中间件）返回，仍须满足规则 6.2「非 2xx 一律 no-store」
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /api/files/* 缓存语义（specs/storage-signed-direct-delivery.md）", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(tmpDir, "1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, OWN_KEY), "x");
  });

  it("会话直连：private（共享缓存不得存储），浏览器仍长期缓存；不输出 Vary", async () => {
    const res = await router.request(`/api/files/${OWN_KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("Vary")).toBeNull();
  });

  it("签名凭据：public 且寿命封顶到签名剩余有效期", async () => {
    mocks.authenticate.mockResolvedValue({
      // 与真实鉴权中间件同源：401 由 failCode 构造（no-store 在构造点单点给出）
      error: failCode(401, "auth.not_authenticated"),
    });
    const { expires, signature } = signFileUrlParams(OWN_KEY, 60);
    const res = await router.request(
      `/api/files/${OWN_KEY}?expires=${expires}&signature=${signature}`,
    );
    expect(res.status).toBe(200);
    const cacheControl = res.headers.get("Cache-Control")!;
    expect(cacheControl).toMatch(/^public, max-age=\d+, immutable$/);
    const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)![1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(60);
  });

  it("404 / 401 / 416 一律 no-store", async () => {
    const missing = await router.request(`/api/files/${MISSING_KEY}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");

    const rangeKey = `1/ab/${HASH_A}.mp4`;
    await fs.writeFile(path.join(tmpDir, rangeKey), "01234567");
    const beyond = await router.request(`/api/files/${rangeKey}`, {
      headers: { Range: "bytes=8-" },
    });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("Cache-Control")).toBe("no-store");

    mocks.authenticate.mockResolvedValue({
      // 与真实鉴权中间件同源：401 由 failCode 构造（no-store 在构造点单点给出）
      error: failCode(401, "auth.not_authenticated"),
    });
    const unauth = await router.request(`/api/files/${OWN_KEY}`);
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("Cache-Control")).toBe("no-store");
  });
});
