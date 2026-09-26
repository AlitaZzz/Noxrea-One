import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  persist: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@server/core/config", () => ({
  getConfig: () => ({
    MAX_UPLOAD_SIZE_MB: 1,
    UPLOAD_DIR: "uploads",
    LOG_LEVEL: "silent",
    ALLOW_INSECURE_SECRETS: true,
  }),
}));

vi.mock("@server/http/middleware/auth", () => ({
  authenticateRequest: mocks.authenticate,
}));

vi.mock("@server/services/storage/backends/local", () => ({
  localStorage: { baseDir: "", save: mocks.save, stat: vi.fn() },
}));

vi.mock("@server/services/storage/persist", () => ({
  persistFileObject: mocks.persist,
}));

vi.mock("@server/services/storage/media-probe", () => ({
  probeVideoIntegrity: vi.fn(),
  probeVideoMetaCached: vi.fn(),
}));

import { router } from "./upload";

const MB = 1024 * 1024;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ user: { id: 1 } });
  mocks.persist.mockResolvedValue({ width: null, height: null, duration: null });
});

const errorOf = async (res: Response): Promise<{ error: string; ctx?: unknown }> =>
  (await res.json()) as { error: string; ctx?: unknown };

describe("POST /api/files/upload 体积校验", () => {
  it("Content-Length 已超限（含 multipart 余量）时 413，不进入 multipart 解析", async () => {
    // 声明 3MB > 1MB 限制 + 1MB 余量：必须在缓冲整个请求体之前拒绝
    const res = await router.request("/api/files/upload", {
      method: "POST",
      headers: { "content-length": String(3 * MB) },
      body: "x".repeat(1024),
    });
    expect(res.status).toBe(413);
    const body = await errorOf(res);
    expect(body.error).toBe("upload.file_too_large");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("Content-Length 在余量内但实际文件超限时 413", async () => {
    // 1.5MB：请求总长低于 2MB 预检阈值，走到逐字段 size 校验才拒绝
    const form = new FormData();
    form.append("file", new File([new Uint8Array(1.5 * MB).fill(0x61)], "a.png", { type: "image/png" }));
    const res = await router.request("/api/files/upload", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).error).toBe("upload.file_too_large");
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
