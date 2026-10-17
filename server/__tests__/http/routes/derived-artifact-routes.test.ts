/**
 * 雪碧图 / 预览代理路由：产物复用、同产物并发合并、发起者断开不连累搭车者、
 * 过载与失败的映射、空产物不发布、临时文件不残留
 * （真实 createMediaEditRoute、ensureArtifact 与 LocalStorageBackend）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  createSprite: vi.fn(),
  createProxy: vi.fn(),
  probeMeta: vi.fn(),
  probeIntegrity: vi.fn(),
  checkRateLimit: vi.fn(() => ({ allowed: true })),
}));

const cfg = vi.hoisted(() => ({ uploadDir: "" }));

vi.mock("@server/core/config", () => ({
  getConfig: () => ({ UPLOAD_DIR: cfg.uploadDir, FFMPEG_PATH: "ffmpeg", LOG_LEVEL: "silent", ALLOW_INSECURE_SECRETS: true }),
}));
vi.mock("@server/http/middleware/auth", () => ({ authenticateRequest: mocks.authenticate }));
vi.mock("@server/services/storage/video-frames", () => ({
  createFrameSprite: mocks.createSprite,
  createScrubProxy: mocks.createProxy,
}));
vi.mock("@server/services/storage/media-probe", () => ({
  probeVideoMetaCached: mocks.probeMeta,
  probeVideoIntegrity: mocks.probeIntegrity,
}));
vi.mock("@server/core/settings", () => ({ getSetting: vi.fn() }));
// 形状与真实现一致；雪碧图 / 代理路由 persistsFileObject: false，全程不应接入限流
// （用例内断言 spy 未被调用，即路由级验证「含缓存命中也不计数」）
vi.mock("@server/core/ratelimit", () => ({ checkUserRateLimit: mocks.checkRateLimit }));

import { router as spriteRouter } from "@server/http/routes/frame-sprite";
import { router as proxyRouter } from "@server/http/routes/video-proxy";
import { initStorageBackend } from "@server/services/storage/service";
import { LocalStorageBackend } from "@server/services/storage/backends/local";
import { MediaPoolBusyError } from "@server/services/storage/media-pool";

const USER_ID = 3;
const SOURCE_KEY = "3/ab/video.mp4";

const routes = [
  { name: "frame-sprite", router: spriteRouter, url: "/api/files/frame-sprite", generate: mocks.createSprite, outDir: "_sprite", failure: "frame_sprite.generation_failed" },
  { name: "video-proxy", router: proxyRouter, url: "/api/files/video-proxy", generate: mocks.createProxy, outDir: "_proxy", failure: "video_proxy.generation_failed" },
] as const;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "derived-routes-"));
  // 后端与工作区根都锚定隔离目录：uploadRoot() 惰性读 config，beforeAll 落定即可
  cfg.uploadDir = root;
  initStorageBackend(new LocalStorageBackend(root));
  await fs.mkdir(path.join(root, "3/ab"), { recursive: true });
  await fs.writeFile(path.join(root, SOURCE_KEY), "video");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ user: { id: USER_ID } });
  mocks.probeMeta.mockResolvedValue({ duration: 4, fps: 30, width: 640 });
  mocks.probeIntegrity.mockResolvedValue({ decodableDuration: 4, truncated: false });
  await fs.rm(path.join(root, "_sprite"), { recursive: true, force: true });
  await fs.rm(path.join(root, "_proxy"), { recursive: true, force: true });
  await fs.rm(path.join(root, "_tmp"), { recursive: true, force: true });
});

const post = (router: typeof spriteRouter, url: string, signal?: AbortSignal) =>
  router.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_key: SOURCE_KEY }),
    signal,
  });

const listDir = (dir: string) => fs.readdir(path.join(root, dir)).catch(() => [] as string[]);
const jsonOf = async (res: Response) => (await res.json()) as { data?: { url: string }; error?: string };

describe.each(routes)("$name 路由", ({ router, url, generate, outDir, failure }) => {
  it("首次请求生成并落盘，再次请求直接复用，临时文件不残留", async () => {
    generate.mockImplementation(async (_video: string, out: string) => { await fs.writeFile(out, "artifact"); });

    const first = await post(router, url);
    const second = await post(router, url);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await jsonOf(first)).data?.url).toBe((await jsonOf(second)).data?.url);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await listDir(outDir)).toHaveLength(1);
    expect(await listDir("_tmp")).toEqual([]);
    // 路由级验证不接入按用户限流：含缓存命中的复用请求也不计数（业务规则 5.2）
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it("同一产物的并发请求只生成一次", async () => {
    const gate = deferred();
    generate.mockImplementation(async (_video: string, out: string) => {
      await gate.promise;
      await fs.writeFile(out, "artifact");
    });

    const a = post(router, url);
    const b = post(router, url);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    gate.resolve();

    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  // 字符串原因即 @hono/node-server 在客户端断开时的实际行为
  it.each([
    ["缺省原因", undefined],
    ["字符串原因", "Client connection prematurely closed."],
  ])("发起者断开（%s）回 499，不连累搭车者：生成继续，搭车者拿到产物", async (_label, reason) => {
    const gate = deferred();
    generate.mockImplementation(async (_video: string, out: string) => {
      await gate.promise;
      await fs.writeFile(out, "artifact");
    });
    const leader = new AbortController();

    const leaderRes = post(router, url, leader.signal);
    const followerRes = post(router, url);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    leader.abort(reason);
    expect((await leaderRes).status).toBe(499);

    gate.resolve();
    const follower = await followerRes;
    expect(follower.status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await listDir(outDir)).toHaveLength(1);
  });

  it("媒体池过载映射为 503 media.busy，不残留临时文件，之后可重新生成", async () => {
    generate.mockRejectedValueOnce(new MediaPoolBusyError("ffmpeg_heavy", "global", "queue_full"));

    const busy = await post(router, url);
    expect(busy.status).toBe(503);
    expect(busy.headers.get("Retry-After")).toBe("5");
    expect((await jsonOf(busy)).error).toBe("media.busy");
    expect(await listDir("_tmp")).toEqual([]);

    generate.mockImplementation(async (_video: string, out: string) => { await fs.writeFile(out, "artifact"); });
    expect((await post(router, url)).status).toBe(200);
  });

  it("个人名额过载（scope=user）映射为 429 media.user_busy", async () => {
    generate.mockRejectedValueOnce(new MediaPoolBusyError("ffmpeg_heavy", "user", "queue_full"));

    const busy = await post(router, url);
    expect(busy.status).toBe(429);
    expect(busy.headers.get("Retry-After")).toBe("5");
    expect((await jsonOf(busy)).error).toBe("media.user_busy");
    expect(await listDir("_tmp")).toEqual([]);
  });

  it("生成出空文件按失败处理：映射为路由的失败码，不发布产物", async () => {
    generate.mockImplementation(async (_video: string, out: string) => { await fs.writeFile(out, ""); });

    const res = await post(router, url);

    expect(res.status).toBe(500);
    expect((await jsonOf(res)).error).toBe(failure);
    expect(await listDir(outDir)).toEqual([]);
    expect(await listDir("_tmp")).toEqual([]);
  });

  it("生成失败由全体等待者共享，映射为路由的失败码且不残留临时文件", async () => {
    const gate = deferred();
    generate.mockImplementation(async (_video: string, out: string) => {
      await fs.writeFile(out, "partial");
      await gate.promise;
      throw new Error("ffmpeg exited with code 1");
    });

    const a = post(router, url);
    const b = post(router, url);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);

    expect([ra.status, rb.status]).toEqual([500, 500]);
    expect((await jsonOf(ra)).error).toBe(failure);
    expect((await jsonOf(rb)).error).toBe(failure);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await listDir("_tmp")).toEqual([]);
    expect(await listDir(outDir)).toEqual([]);
  });
});
