import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { z } from "zod";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  root: "",
}));

vi.mock("@server/core/config", () => ({
  // workspace 的 uploadRoot() 每次调用即时读取 UPLOAD_DIR：beforeAll 里
  // 先建好隔离目录再触发请求即可，无需在模块加载期落定
  getConfig: () => ({
    UPLOAD_DIR: mocks.root,
    FFMPEG_PATH: "ffmpeg",
    FFPROBE_PATH: "ffprobe",
    LOG_LEVEL: "silent",
    ALLOW_INSECURE_SECRETS: true,
  }),
}));

vi.mock("@server/http/middleware/auth", () => ({
  authenticateRequest: mocks.authenticate,
}));

import { createMediaEditRoute, type MediaEditContext } from "@server/http/routes/media-edit";
import { initStorageBackend } from "@server/services/storage/service";
import { LocalStorageBackend } from "@server/services/storage/backends/local";
import { MediaPoolBusyError } from "@server/services/storage/media-pool";

const USER_ID = 3;
const schema = z.object({ video_key: z.string().min(1) });

type Ctx = MediaEditContext<{ video_key: string }>;

function buildApp(
  run: (ctx: Ctx) => Promise<Response>,
  mapError?: (err: unknown) => Response | undefined,
  options: { persistsFileObject?: boolean } = {},
) {
  const app = new Hono();
  app.post(
    "/api/test/media",
    createMediaEditRoute({
      schema,
      resolveKey: (d) => d.video_key,
      name: "testop",
      failureCode: "clip.extract_failed",
      ...(mapError ? { mapError } : {}),
      ...options,
      run,
    }),
  );
  return app;
}

let root = "";

beforeAll(async () => {
  root = mocks.root = await fs.mkdtemp(path.join(os.tmpdir(), "media-edit-"));
  // 路由工厂经 getStorageBackend() 取 stat / 源租约：注入指向隔离根的 local 后端
  initStorageBackend(new LocalStorageBackend(root));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ user: { id: USER_ID } });
});

const errorOf = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: string }).error;

const post = (app: Hono, body: unknown) =>
  app.request("/api/test/media", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

async function writeSource(userId = 3): Promise<void> {
  await fs.mkdir(path.join(root, `${userId}/ab`), { recursive: true });
  await fs.writeFile(path.join(root, `${userId}/ab/ok.png`), "x");
}

describe("createMediaEditRoute 前置链路", () => {
  it("请求体不是 JSON 时 400", async () => {
    const res = await post(buildApp(vi.fn()), "not-json");
    expect(res.status).toBe(400);
  });

  it("schema 校验失败时 422", async () => {
    const res = await post(buildApp(vi.fn()), {});
    expect(res.status).toBe(422);
  });

  it("源键不属于当前用户时 403（归属校验）", async () => {
    const res = await post(buildApp(vi.fn()), { video_key: "999/ab/hash.png" });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("files.access_denied");
  });

  it("源键首段合法但解析后逃出存储根时 403（穿越校验）", async () => {
    const res = await post(buildApp(vi.fn()), { video_key: "3/../../outside.png" });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("files.invalid_path");
  });

  it("源文件不存在时 404", async () => {
    const res = await post(buildApp(vi.fn()), { video_key: "3/ab/missing.png" });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe("media.source_not_found");
  });

  it("校验通过后 run 拿到解析后的绝对路径，按需取得 _tmp 下的独享临时目录", async () => {
    await writeSource();
    const run = vi.fn(async ({ c, tmpDir }: Ctx) => {
      const dir = await tmpDir();
      // 临时目录在 run 执行期间必须可用，重复取得同一个目录
      expect((await fs.stat(dir)).isDirectory()).toBe(true);
      expect(path.dirname(dir)).toBe(path.join(root, "_tmp"));
      expect(await tmpDir()).toBe(dir);
      return c.json({ ok: true });
    });
    const res = await post(buildApp(run), { video_key: "3/ab/ok.png" });

    expect(res.status).toBe(200);
    const ctx = run.mock.calls[0][0];
    expect(ctx.sourceKey).toBe("3/ab/ok.png");
    expect(ctx.sourceInput).toBe(path.resolve(root, "3/ab/ok.png"));
    expect(ctx.userId).toBe(USER_ID);
  });

  it("请求结束后临时目录被清理", async () => {
    await writeSource();
    const run = vi.fn(async ({ c, tmpDir }: Ctx) => {
      await fs.writeFile(path.join(await tmpDir(), "out.bin"), "y");
      return c.json({ ok: true });
    });
    await post(buildApp(run), { video_key: "3/ab/ok.png" });

    expect(await fs.readdir(path.join(root, "_tmp"))).toEqual([]);
  });

  it("run 用不到临时目录时不创建", async () => {
    await writeSource();
    await fs.rm(path.join(root, "_tmp"), { recursive: true, force: true });
    const run = vi.fn(async ({ c }: Ctx) => c.json({ ok: true }));

    expect((await post(buildApp(run), { video_key: "3/ab/ok.png" })).status).toBe(200);
    await expect(fs.access(path.join(root, "_tmp"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("createMediaEditRoute 请求次数限流（specs/media-processing-concurrency.md 规则 5）", () => {
  // 独立用户与源文件：与前面用例的 user 3 共享同一限流键会互相消耗额度，
  // 源键归属也必须与请求者一致（否则 403 先于限流触发）
  const RATE_LIMIT_USER = 42;
  const RATE_LIMIT_KEY = "42/ab/ok.png";

  beforeEach(async () => {
    mocks.authenticate.mockResolvedValue({ user: { id: RATE_LIMIT_USER } });
    await fs.mkdir(path.join(root, "42/ab"), { recursive: true });
    await fs.writeFile(path.join(root, "42/ab/ok.png"), "x");
  });

  it("产出类编辑超过 20 次/60 秒返回 429，带 Retry-After 并禁止缓存", async () => {
    const app = buildApp(async ({ c }) => c.json({ ok: true }));

    for (let i = 0; i < 20; i++) {
      const res = await post(app, { video_key: RATE_LIMIT_KEY });
      expect(res.status).toBe(200);
    }

    const limited = await post(app, { video_key: RATE_LIMIT_KEY });
    expect(limited.status).toBe(429);
    expect(await errorOf(limited)).toBe("common.rate_limited");
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
  });

  it("预览产物路由（persistsFileObject: false）不计数，21 次请求全部通过", async () => {
    const app = buildApp(async ({ c }) => c.json({ ok: true }), undefined, { persistsFileObject: false });

    for (let i = 0; i < 21; i++) {
      const res = await post(app, { video_key: RATE_LIMIT_KEY });
      expect(res.status).toBe(200);
    }
  });
});

describe("createMediaEditRoute 错误映射", () => {
  // 独立用户与源文件：限流键按「业务名 + userId」隔离，避免与其他 describe
  // 共享 user 3 的 20 次/60 秒窗口（其计数已贴近上限）
  const ERROR_USER = 5;
  const ERROR_KEY = "5/ab/ok.png";

  beforeEach(async () => {
    mocks.authenticate.mockResolvedValue({ user: { id: ERROR_USER } });
    await writeSource(ERROR_USER);
  });

  const cases: Array<[Error, number, string]> = [
    [Object.assign(new Error("aborted"), { name: "AbortError" }), 499, "media.cancelled"],
    [new Error("spawn ffmpeg ENOENT"), 500, "media.ffmpeg_missing"],
    [new Error("ffmpeg timed out after 60s"), 504, "media.timeout"],
    [new Error("boom"), 500, "clip.extract_failed"],
    [new MediaPoolBusyError("ffmpeg_heavy", "global", "queue_full"), 503, "media.busy"],
    [new MediaPoolBusyError("ffmpeg_light", "global", "wait_timeout"), 503, "media.busy"],
    [new MediaPoolBusyError("ffmpeg_heavy", "user", "queue_full"), 429, "media.user_busy"],
    [new MediaPoolBusyError("sharp", "global", "wait_timeout"), 503, "media.busy"],
  ];

  for (const [err, status, code] of cases) {
    it(`${err.message} → ${status} ${code}`, async () => {
      const run = vi.fn(async (): Promise<Response> => {
        throw err;
      });
      const res = await post(buildApp(run), { video_key: ERROR_KEY });
      expect(res.status).toBe(status);
      expect(await errorOf(res)).toBe(code);
    });
  }

  it.each([
    [{ pool: "ffmpeg_heavy", scope: "global", retryAfter: "5", status: 503, code: "media.busy" }],
    [{ pool: "ffmpeg_light", scope: "global", retryAfter: "1", status: 503, code: "media.busy" }],
    [{ pool: "ffmpeg_heavy", scope: "user", retryAfter: "5", status: 429, code: "media.user_busy" }],
  ] as const)("$pool 池 scope=$scope 过载带 Retry-After 且禁止缓存", async ({ pool, scope, retryAfter, status, code }) => {
    const run = vi.fn(async (): Promise<Response> => {
      throw new MediaPoolBusyError(pool, scope, "queue_full");
    });
    const res = await post(buildApp(run), { video_key: ERROR_KEY });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toBe(code);
    expect(res.headers.get("Retry-After")).toBe(retryAfter);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("mapError 返回 Response 时优先采用", async () => {
    const run = vi.fn(async (): Promise<Response> => {
      throw new Error("no audio");
    });
    const app = buildApp(run, () => Response.json({ error: "custom.code" }, { status: 422 }));
    const res = await post(app, { video_key: ERROR_KEY });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toBe("custom.code");
  });

  it("鉴权错误原样透传", async () => {
    mocks.authenticate.mockResolvedValue({
      error: Response.json({ error: "auth.token_invalid" }, { status: 401 }),
    });
    const res = await post(buildApp(vi.fn()), { video_key: "3/ab/ok.png" });
    expect(res.status).toBe(401);
  });
});
