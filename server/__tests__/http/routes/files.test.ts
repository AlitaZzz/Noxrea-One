import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const mocks = vi.hoisted(() => ({
  getResizedWebP: vi.fn(),
  getVideoPosterWebP: vi.fn(),
  authenticate: vi.fn(),
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
  it("拒绝 .. 段的路径穿越（..%2F 经解码后落入分段检查）", async () => {
    const res = await router.request("/api/files/..%2Fsecret.png");
    expect(res.status).toBe(403);
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

  it("绝对路径 key 走缩放分支后仍被校验拦下（403）", async () => {
    const res = await router.request("/api/files//etc/x.png?w=100");
    expect(mocks.getResizedWebP).toHaveBeenCalledWith(
      "/etc/x.png",
      100,
      expect.anything()
    );
    expect(res.status).toBe(403);
  });

  it("缩放产物位于 base 内时放行并返回 webp", async () => {
    const cacheKey = "_cache/100/u1/ab/ok.webp";
    await fs.mkdir(path.join(tmpDir, "_cache/100/u1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, cacheKey), "x");
    mocks.getResizedWebP.mockResolvedValue(cacheKey);

    const res = await router.request("/api/files/u1/ab/ok.png?w=100");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  it("文件不存在返回 404", async () => {
    const res = await router.request("/api/files/u1/ab/missing.png");
    expect(res.status).toBe(404);
  });

  it("正常文件按扩展名返回 Content-Type", async () => {
    await fs.mkdir(path.join(tmpDir, "u1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "u1/ab/ok.png"), "x");

    const res = await router.request("/api/files/u1/ab/ok.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });
});

describe("GET /api/files/* Range 请求", () => {
  beforeEach(async () => {
    // 8 字节文件：Range 边界一目了然
    await fs.mkdir(path.join(tmpDir, "u1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "u1/ab/r.mp4"), "01234567");
  });

  it("合法区间返回 206 与 Content-Range", async () => {
    const res = await router.request("/api/files/u1/ab/r.mp4", {
      headers: { Range: "bytes=2-5" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-5/8");
    expect(res.headers.get("Content-Length")).toBe("4");
    expect(await res.text()).toBe("2345");
  });

  it("start 越界返回 416 并携带通配 Content-Range", async () => {
    const res = await router.request("/api/files/u1/ab/r.mp4", {
      headers: { Range: "bytes=8-" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */8");
  });

  it("end < start 的畸形区间返回 416，不再产出负长度流", async () => {
    const res = await router.request("/api/files/u1/ab/r.mp4", {
      headers: { Range: "bytes=5-2" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */8");
  });
});

describe("GET /api/files/* 媒体池过载", () => {
  it("图片缩放过载返回 503，不回退原图", async () => {
    mocks.getResizedWebP.mockRejectedValue(new MediaPoolBusyError("sharp", "global", "queue_full"));
    const res = await router.request("/api/files/u1/ab/ok.png?w=100");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(((await res.json()) as { error: string }).error).toBe("media.busy");
  });

  it("视频海报过载返回 503（而非 404）", async () => {
    mocks.getVideoPosterWebP.mockRejectedValue(new MediaPoolBusyError("ffmpeg_heavy", "global", "wait_timeout"));
    const res = await router.request("/api/files/u1/ab/r.mp4?w=100");
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
    await fs.mkdir(path.join(tmpDir, "u1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "u1/ab/signed.png"), "x");
  });

  it("无会话且无签名 → 401", async () => {
    const res = await router.request("/api/files/u1/ab/signed.png");
    expect(res.status).toBe(401);
  });

  it("有效签名放行并返回内容", async () => {
    const { expires, signature } = signFileUrlParams("u1/ab/signed.png", 60);
    const res = await router.request(
      `/api/files/u1/ab/signed.png?expires=${expires}&signature=${signature}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("x");
  });

  it("过期签名拒绝", async () => {
    const { expires, signature } = signFileUrlParams("u1/ab/signed.png", 0);
    const res = await router.request(
      `/api/files/u1/ab/signed.png?expires=${expires}&signature=${signature}`,
    );
    expect(res.status).toBe(401);
  });

  it("篡改签名拒绝", async () => {
    const { expires, signature } = signFileUrlParams("u1/ab/signed.png", 60);
    const tampered = signature.slice(0, -1) + (signature.endsWith("a") ? "b" : "a");
    const res = await router.request(
      `/api/files/u1/ab/signed.png?expires=${expires}&signature=${tampered}`,
    );
    expect(res.status).toBe(401);
  });

  it("签名与 key 绑定：A 的签名请求 B 拒绝", async () => {
    const { expires, signature } = signFileUrlParams("u1/ab/other.png", 60);
    const res = await router.request(
      `/api/files/u1/ab/signed.png?expires=${expires}&signature=${signature}`,
    );
    expect(res.status).toBe(401);
  });

  it("会话请求不受签名逻辑影响", async () => {
    mocks.authenticate.mockResolvedValue({ user: { id: 1 } });
    const res = await router.request("/api/files/u1/ab/signed.png");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/files/* redirect 分发（spec 规则 4/5）", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(tmpDir, "u1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "u1/ab/ok.png"), "x");
    resetTestSettings({
      "storage.s3.delivery": "redirect",
      "storage.s3.signed_url_ttl_seconds": 600,
    });
  });

  it("redirect 模式 302 到预签名 URL，字节不经应用服务器（Cache-Control no-store）", async () => {
    const res = await router.request("/api/files/u1/ab/ok.png");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `https://s3.example/get?key=${encodeURIComponent("u1/ab/ok.png")}`,
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("");

    const call = backend.presignCalls.at(-1)!;
    expect(call.key).toBe("u1/ab/ok.png");
    expect(call.opts).toMatchObject({
      ttlSeconds: 600,
      cacheControl: "public, max-age=600, immutable",
    });
  });

  it("?download 透传 disposition，filename 参数缺扩展名时补上", async () => {
    const res = await router.request("/api/files/u1/ab/ok.png?download=1&filename=%E6%8A%A5%E5%91%8A");
    expect(res.status).toBe(302);
    const opts = backend.presignCalls.at(-1)!.opts;
    expect(opts?.responseContentDisposition).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("报告.png")}`,
    );
  });

  it("?w= 命中缩放缓存后 redirect 派生 key", async () => {
    const cacheKey = "_cache/100/u1/ab/ok.webp";
    await fs.mkdir(path.join(tmpDir, "_cache/100/u1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, cacheKey), "x");
    mocks.getResizedWebP.mockResolvedValue(cacheKey);

    const res = await router.request("/api/files/u1/ab/ok.png?w=100");
    expect(res.status).toBe(302);
    expect(backend.presignCalls.at(-1)!.key).toBe(cacheKey);
  });

  it("proxy 模式下具备预签名能力也不 302", async () => {
    resetTestSettings({ "storage.s3.delivery": "proxy" });
    const res = await router.request("/api/files/u1/ab/ok.png");
    expect(res.status).toBe(200);
    expect(backend.presignCalls).toHaveLength(0);
  });
});
