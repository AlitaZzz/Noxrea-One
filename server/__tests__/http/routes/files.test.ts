import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

import { router } from "@server/http/routes/files";
import { initStorageBackend } from "@server/services/storage/service";
import { LocalStorageBackend } from "@server/services/storage/backends/local";
import { MediaPoolBusyError } from "@server/services/storage/media-pool";
import { signFileUrlParams } from "@server/services/storage/file-url-signature";
import { resetTestSettings } from "../../helpers/settings";

/** local 语义 + 预签名能力（redirect 分发的分发形态路由级验证；签名产出为固定假 URL） */
class PresignableLocalBackend extends LocalStorageBackend {
  readonly presignCalls: Array<{ key: string; opts?: Record<string, unknown> }> = [];
  async presignGet(
    key: string,
    opts?: { ttlSeconds?: number; responseContentDisposition?: string; cacheControl?: string },
  ): Promise<string> {
    this.presignCalls.push({ key, opts });
    return `https://s3.example/get?key=${encodeURIComponent(key)}`;
  }
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
  // 本文件默认 proxy 分发（流式语义）；redirect 分发由专用 describe 显式开启
  resetTestSettings({ "storage.s3.delivery": "proxy" });
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
      error: Response.json({ error: "auth.not_authenticated" }, { status: 401 }),
    });
    const { expires, signature } = signFileUrlParams("../secret.png", 60);
    const res = await router.request(`/api/files/..%2Fsecret.png?expires=${expires}&signature=${signature}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("files.invalid_path");
  });

  it("畸形百分号编码返回 400，而非未捕获 URIError 变 500", async () => {
    const res = await router.request("/api/files/%zz.png");
    expect(res.status).toBe(400);
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
    const cacheKey = `_cache/100/1/ab/${HASH_A}.webp`;
    await fs.mkdir(path.join(tmpDir, "_cache/100/1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, cacheKey), "x");
    mocks.getResizedWebP.mockResolvedValue(cacheKey);

    const res = await router.request(`/api/files/${OWN_KEY}?w=100`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
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
    `_cache/200/2/ab/${HASH_A}.webp`,
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

  it("本人 staging / _cache / _posters / 新形态派生 key 放行", async () => {
    const files: Array<[string, string]> = [
      [`staging/1/${uuid}`, "x"],
      [`_cache/200/1/ab/${HASH_A}.webp`, "x"],
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

  it("签名路径不叠加归属比对：有效签名放行他人命名空间 key", async () => {
    mocks.authenticate.mockResolvedValue({
      error: Response.json({ error: "auth.not_authenticated" }, { status: 401 }),
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
  it("图片缩放过载返回 503，不回退原图", async () => {
    await fs.mkdir(path.join(tmpDir, "1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, OWN_KEY), "x");
    mocks.getResizedWebP.mockRejectedValue(new MediaPoolBusyError("sharp", "global", "queue_full"));
    const res = await router.request(`/api/files/${OWN_KEY}?w=100`);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(((await res.json()) as { error: string }).error).toBe("media.busy");
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
  });
});

describe("GET /api/files/* 双凭据（spec 规则 6）", () => {
  beforeEach(async () => {
    // 无会话：鉴权失败，只能靠签名凭据放行
    mocks.authenticate.mockResolvedValue({
      error: Response.json({ error: "auth.not_authenticated" }, { status: 401 }),
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

describe("GET /api/files/* redirect 分发（spec 规则 4/5）", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(tmpDir, "1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, OWN_KEY), "x");
    resetTestSettings({
      "storage.s3.delivery": "redirect",
      "storage.s3.signed_url_ttl_seconds": 600,
    });
  });

  it("redirect 模式 302 到预签名 URL，字节不经应用服务器（Cache-Control no-store）", async () => {
    const res = await router.request(`/api/files/${OWN_KEY}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `https://s3.example/get?key=${encodeURIComponent(OWN_KEY)}`,
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("");

    const call = backend.presignCalls.at(-1)!;
    expect(call.key).toBe(OWN_KEY);
    expect(call.opts).toMatchObject({
      ttlSeconds: 600,
      cacheControl: "public, max-age=600, immutable",
    });
  });

  it("?download 透传 disposition，filename 参数缺扩展名时补上", async () => {
    const res = await router.request(`/api/files/${OWN_KEY}?download=1&filename=%E6%8A%A5%E5%91%8A`);
    expect(res.status).toBe(302);
    const opts = backend.presignCalls.at(-1)!.opts;
    expect(opts?.responseContentDisposition).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("报告.png")}`,
    );
  });

  it("?w= 命中缩放缓存后 redirect 派生 key", async () => {
    const cacheKey = `_cache/100/1/ab/${HASH_A}.webp`;
    await fs.mkdir(path.join(tmpDir, "_cache/100/1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, cacheKey), "x");
    mocks.getResizedWebP.mockResolvedValue(cacheKey);

    const res = await router.request(`/api/files/${OWN_KEY}?w=100`);
    expect(res.status).toBe(302);
    expect(backend.presignCalls.at(-1)!.key).toBe(cacheKey);
  });

  it("proxy 模式下具备预签名能力也不 302", async () => {
    resetTestSettings({ "storage.s3.delivery": "proxy" });
    const res = await router.request(`/api/files/${OWN_KEY}`);
    expect(res.status).toBe(200);
    expect(backend.presignCalls).toHaveLength(0);
  });
});
