import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const mocks = vi.hoisted(() => ({
  getResizedWebP: vi.fn(),
  getVideoPosterWebP: vi.fn(),
  stat: vi.fn(),
  baseDir: "",
}));

vi.mock("@server/core/config", () => ({
  getConfig: () => ({
    UPLOAD_DIR: "uploads",
    FFMPEG_PATH: "ffmpeg",
    FFPROBE_PATH: "ffprobe",
    LOG_LEVEL: "silent",
    ALLOW_INSECURE_SECRETS: true,
  }),
}));

vi.mock("@server/services/storage/backends/local", () => ({
  localStorage: {
    get baseDir() {
      return mocks.baseDir;
    },
    stat: mocks.stat,
    delete: vi.fn(),
  },
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

import { router } from "./files";

let tmpDir = "";

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "files-route-"));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.baseDir = tmpDir;
  mocks.getResizedWebP.mockResolvedValue(null);
  mocks.getVideoPosterWebP.mockResolvedValue(null);
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
    mocks.stat.mockResolvedValue({ size: 1, mtimeMs: 0 });

    const res = await router.request("/api/files/u1/ab/ok.png?w=100");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  it("文件不存在返回 404", async () => {
    mocks.stat.mockResolvedValue(null);
    const res = await router.request("/api/files/u1/ab/missing.png");
    expect(res.status).toBe(404);
  });

  it("正常文件按扩展名返回 Content-Type", async () => {
    await fs.mkdir(path.join(tmpDir, "u1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "u1/ab/ok.png"), "x");
    mocks.stat.mockResolvedValue({ size: 1, mtimeMs: 0 });

    const res = await router.request("/api/files/u1/ab/ok.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });
});

describe("GET /api/files/* Range 请求", () => {
  beforeEach(async () => {
    // 8 字节文件：Range 边界一目了然
    mocks.stat.mockResolvedValue({ size: 8, mtimeMs: 0 });
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
