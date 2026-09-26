import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { z } from "zod";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  baseDir: "",
  authenticate: vi.fn(),
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

vi.mock("@server/http/middleware/auth", () => ({
  authenticateRequest: mocks.authenticate,
}));

vi.mock("@server/services/storage/backends/local", () => ({
  localStorage: {
    get baseDir() {
      return mocks.baseDir;
    },
  },
}));

import { createMediaEditRoute, type MediaEditContext } from "./media-edit";

const USER_ID = 3;
const schema = z.object({ video_key: z.string().min(1) });

type Ctx = MediaEditContext<{ video_key: string }>;

function buildApp(run: (ctx: Ctx) => Promise<Response>, mapError?: (err: unknown) => Response | undefined) {
  const app = new Hono();
  app.post(
    "/api/test/media",
    createMediaEditRoute({
      schema,
      resolveKey: (d) => d.video_key,
      name: "testop",
      failureCode: "clip.extract_failed",
      ...(mapError ? { mapError } : {}),
      run,
    }),
  );
  return app;
}

let tmpDir = "";

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "media-edit-"));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.baseDir = tmpDir;
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

  it("校验通过后 run 拿到解析后的绝对路径与临时目录，响应正常返回", async () => {
    await fs.mkdir(path.join(tmpDir, "3/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "3/ab/ok.png"), "x");
    const run = vi.fn(async ({ c, tmpDir: dir }: Ctx) => {
      // 临时目录在 run 执行期间必须可用
      expect((await fs.stat(dir)).isDirectory()).toBe(true);
      return c.json({ ok: true });
    });
    const res = await post(buildApp(run), { video_key: "3/ab/ok.png" });

    expect(res.status).toBe(200);
    const ctx = run.mock.calls[0][0];
    expect(ctx.sourceKey).toBe("3/ab/ok.png");
    expect(ctx.sourcePath).toBe(path.resolve(tmpDir, "3/ab/ok.png"));
    expect(ctx.userId).toBe(USER_ID);
  });

  it("请求结束后临时目录被清理", async () => {
    await fs.mkdir(path.join(tmpDir, "3/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "3/ab/ok.png"), "x");
    const run = vi.fn(async ({ c, tmpDir: dir }: Ctx) => {
      await fs.writeFile(path.join(dir, "out.bin"), "y");
      return c.json({ ok: true });
    });
    await post(buildApp(run), { video_key: "3/ab/ok.png" });

    const leftovers = await fs.readdir(path.join(tmpDir, "_tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("createMediaEditRoute 错误映射", () => {
  const cases: Array<[Error, number, string]> = [
    [Object.assign(new Error("aborted"), { name: "AbortError" }), 499, "media.cancelled"],
    [new Error("spawn ffmpeg ENOENT"), 500, "media.ffmpeg_missing"],
    [new Error("ffmpeg timed out after 60s"), 504, "media.timeout"],
    [new Error("boom"), 500, "clip.extract_failed"],
  ];

  for (const [err, status, code] of cases) {
    it(`${err.message} → ${status} ${code}`, async () => {
      await fs.mkdir(path.join(tmpDir, "3/ab"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "3/ab/ok.png"), "x");
      const run = vi.fn(async (): Promise<Response> => {
        throw err;
      });
      const res = await post(buildApp(run), { video_key: "3/ab/ok.png" });
      expect(res.status).toBe(status);
      expect(await errorOf(res)).toBe(code);
    });
  }

  it("mapError 返回 Response 时优先采用", async () => {
    await fs.mkdir(path.join(tmpDir, "3/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "3/ab/ok.png"), "x");
    const run = vi.fn(async (): Promise<Response> => {
      throw new Error("no audio");
    });
    const app = buildApp(run, () => Response.json({ error: "custom.code" }, { status: 422 }));
    const res = await post(app, { video_key: "3/ab/ok.png" });
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
