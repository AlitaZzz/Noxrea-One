import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { z } from "zod";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  root: "",
  quotaGate: vi.fn(),
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

vi.mock("@server/services/storage/quota", () => ({
  findQuotaGateViolation: mocks.quotaGate,
}));

import { createMediaEditRoute, type MediaEditContext } from "@server/http/routes/media-edit";
import { initStorageBackend } from "@server/services/storage/service";
import { LocalStorageBackend } from "@server/services/storage/backends/local";
import { MediaPoolBusyError } from "@server/services/storage/media-pool";

const USER_ID = 3;
// 归属校验（specs/file-access-ownership.md）要求源键为严格形态：规范内容 key
const HASH = "ab".repeat(32);
const HASH_MISSING = "cd".repeat(32);
const contentKey = (userId: number, hash = HASH) => `${userId}/${hash.slice(0, 2)}/${hash}.png`;
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
  mocks.quotaGate.mockResolvedValue(null);
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
  const key = contentKey(userId);
  await fs.mkdir(path.dirname(path.join(root, key)), { recursive: true });
  await fs.writeFile(path.join(root, key), "x");
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
    const res = await post(buildApp(vi.fn()), { video_key: contentKey(999) });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("files.access_denied");
  });

  it("解析不出属主的畸形 key（含穿越形态）一律 403（fail-closed）", async () => {
    // 严格形态 key 不可能包含 ..：穿越/畸形键在归属处即被拒，到不了后端穿越守卫
    for (const key of ["3/../../outside.png", "3/ab/notahash.png", "_unknown/3/foo"]) {
      const res = await post(buildApp(vi.fn()), { video_key: key });
      expect(res.status, key).toBe(403);
      expect(await errorOf(res), key).toBe("files.access_denied");
    }
  });

  it("本人派生 key（内嵌自身属主）放行", async () => {
    const derivedKey = `_cache/100/${contentKey(USER_ID).replace(/\.png$/, "")}.webp`;
    await fs.mkdir(path.dirname(path.join(root, derivedKey)), { recursive: true });
    await fs.writeFile(path.join(root, derivedKey), "x");

    const run = vi.fn(async ({ c, sourceKey }: Ctx) => c.json({ sourceKey }));
    const res = await post(buildApp(run), { video_key: derivedKey });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sourceKey: string }).sourceKey).toBe(derivedKey);
  });

  it("源文件不存在时 404", async () => {
    const res = await post(buildApp(vi.fn()), { video_key: contentKey(USER_ID, HASH_MISSING) });
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
    const res = await post(buildApp(run), { video_key: contentKey(USER_ID) });

    expect(res.status).toBe(200);
    const ctx = run.mock.calls[0][0];
    expect(ctx.sourceKey).toBe(contentKey(USER_ID));
    expect(ctx.sourceInput).toBe(path.resolve(root, contentKey(USER_ID)));
    expect(ctx.userId).toBe(USER_ID);
  });

  it("请求结束后临时目录被清理", async () => {
    await writeSource();
    const run = vi.fn(async ({ c, tmpDir }: Ctx) => {
      await fs.writeFile(path.join(await tmpDir(), "out.bin"), "y");
      return c.json({ ok: true });
    });
    await post(buildApp(run), { video_key: contentKey(USER_ID) });

    expect(await fs.readdir(path.join(root, "_tmp"))).toEqual([]);
  });

  it("run 用不到临时目录时不创建", async () => {
    await writeSource();
    await fs.rm(path.join(root, "_tmp"), { recursive: true, force: true });
    const run = vi.fn(async ({ c }: Ctx) => c.json({ ok: true }));

    expect((await post(buildApp(run), { video_key: contentKey(USER_ID) })).status).toBe(200);
    await expect(fs.access(path.join(root, "_tmp"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("createMediaEditRoute 请求次数限流（specs/media-processing-concurrency.md 规则 5）", () => {
  // 独立用户与源文件：与前面用例的 user 3 共享同一限流键会互相消耗额度，
  // 源键归属也必须与请求者一致（否则 403 先于限流触发）
  const RATE_LIMIT_USER = 42;
  const RATE_LIMIT_KEY = contentKey(RATE_LIMIT_USER);

  beforeEach(async () => {
    mocks.authenticate.mockResolvedValue({ user: { id: RATE_LIMIT_USER } });
    await writeSource(RATE_LIMIT_USER);
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

describe("createMediaEditRoute 存储配额二元门槛（specs/storage-user-quota.md 规则 3）", () => {
  // 独立用户：与前述 describe 共享限流键会互相消耗额度；源键归属须与请求者一致
  const QUOTA_USER = 44;

  beforeEach(() => {
    mocks.authenticate.mockResolvedValue({ user: { id: QUOTA_USER } });
  });

  it("产出类编辑（默认）超限 409 media.quota_exceeded，run 不执行", async () => {
    const run = vi.fn(async ({ c }: Ctx) => c.json({ ok: true }));
    const app = buildApp(run);
    mocks.quotaGate.mockResolvedValueOnce({ usedBytes: 10, quotaBytes: 5 });

    const res = await post(app, { video_key: contentKey(QUOTA_USER) });

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("media.quota_exceeded");
    expect(run).not.toHaveBeenCalled();
  });

  it("派生产物类路由（persistsFileObject: false）不设门槛，超限用户既有内容代理不受影响", async () => {
    await writeSource(QUOTA_USER);
    const run = vi.fn(async ({ c }: Ctx) => c.json({ ok: true }));
    const app = buildApp(run, undefined, { persistsFileObject: false });
    // 持久违规值（非 Once）：本用例门控按设计不触发、断言未被咨询；
    // Once 队列若未被消费会泄漏到后续用例（clearAllMocks 不清 Once 队列）
    mocks.quotaGate.mockResolvedValue({ usedBytes: 10, quotaBytes: 5 });

    const res = await post(app, { video_key: contentKey(QUOTA_USER) });

    expect(res.status).toBe(200);
    expect(mocks.quotaGate).not.toHaveBeenCalled();
  });
});

describe("createMediaEditRoute 错误映射", () => {
  // 独立用户与源文件：限流键按「业务名 + userId」隔离，避免与其他 describe
  // 共享 user 3 的 20 次/60 秒窗口（其计数已贴近上限）
  const ERROR_USER = 5;
  const ERROR_KEY = contentKey(ERROR_USER);

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
    const res = await post(buildApp(vi.fn()), { video_key: contentKey(3) });
    expect(res.status).toBe(401);
  });
});
