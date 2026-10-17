/**
 * 参考素材解析单测（specs/storage-s3-backend.md 规则 12 双凭据）：
 * signed-url / base64 分发、S3 预签名直连、local 后端应用层签名 URL、
 * 签名不可用回退 base64、1:1 同序契约与读取失败上抛。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  backend: {} as { presignGet?: (key: string, opts?: unknown) => Promise<string> },
}));

vi.mock("@server/core/config", () => ({
  getConfig: () => ({
    UPLOAD_DIR: "uploads",
    FFMPEG_PATH: "ffmpeg",
    FFPROBE_PATH: "ffprobe",
    LOG_LEVEL: "silent",
    ALLOW_INSECURE_SECRETS: true,
    JWT_SECRET_KEY: "test-reference-secret",
  }),
}));
vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());
vi.mock("@server/services/storage/service", () => ({
  getStorageBackend: () => mocks.backend,
}));
vi.mock("@server/services/storage/media-source", () => ({
  acquireMediaFile: mocks.acquire,
}));

import { resolveRefImages } from "@server/services/resolvers/reference";
import { verifyFileUrlSignature } from "@server/services/storage/file-url-signature";
import { GenerationFailureError } from "@server/services/tasks/failure";
import { StorageTraversalError } from "@server/services/storage/backend";
import { resetTestSettings } from "../../helpers/settings";

const KEY = `3/ab/${"a".repeat(64)}.png`;
const CONTENT = "png-bytes";

let fixtureFile = "";

beforeEach(async () => {
  vi.clearAllMocks();
  resetTestSettings({ "storage.upstream_ref_delivery": "signed-url" });
  if (!fixtureFile) {
    fixtureFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "reference-")), "asset.png");
    await fs.writeFile(fixtureFile, CONTENT);
  }
  mocks.acquire.mockResolvedValue({ path: fixtureFile, release: vi.fn() });
});

describe("resolveRefImages（规则 12）", () => {
  it("data: URL 直接透传，不触碰后端", async () => {
    mocks.backend = {};
    const out = await resolveRefImages(["data:image/png;base64,AAA"]);
    expect(out).toEqual(["data:image/png;base64,AAA"]);
  });

  it("signed-url 分发：S3 后端即时预签名，不读本机文件", async () => {
    mocks.backend = { presignGet: vi.fn(async (key: string) => `https://s3.example/${key}?sig=1`) };
    const out = await resolveRefImages([KEY]);
    expect(out).toEqual([`https://s3.example/${KEY}?sig=1`]);
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it("base64 分发：读本机文件转 data URL", async () => {
    resetTestSettings({ "storage.upstream_ref_delivery": "base64" });
    mocks.backend = {};
    const out = await resolveRefImages([KEY]);
    expect(out).toEqual([`data:image/png;base64,${Buffer.from(CONTENT).toString("base64")}`]);
  });

  it("local 后端：public_base_url + 应用层 HMAC 签名 URL（签名与 key 绑定）", async () => {
    resetTestSettings({ "network.public_base_url": "https://app.example/" });
    mocks.backend = {};
    const out = await resolveRefImages([KEY]);

    const url = out[0];
    expect(url).toMatch(/^https:\/\/app\.example\/api\/files\//);
    const parsed = new URL(url!);
    expect(parsed.pathname).toBe(`/api/files/${KEY}`);
    expect(
      verifyFileUrlSignature(KEY, parsed.searchParams.get("expires"), parsed.searchParams.get("signature")),
    ).toBe(true);
  });

  it("local 后端未配 public_base_url：签名不可用回退 base64", async () => {
    resetTestSettings({ "network.public_base_url": "" });
    mocks.backend = {};
    const out = await resolveRefImages([KEY]);
    expect(out[0]).toMatch(/^data:image\/png;base64,/);
  });

  it("预签名操作失败：按失败处理，不静默改走 base64（交付形态由设置决定）", async () => {
    mocks.backend = {
      presignGet: vi.fn(async () => {
        throw new Error("gateway down");
      }),
    };
    await expect(resolveRefImages([KEY])).rejects.toMatchObject({
      name: "GenerationFailureError",
      errorCode: "generation.reference_unavailable",
    });
  });

  it("外链 URL 原样透传", async () => {
    mocks.backend = {};
    const out = await resolveRefImages(["https://cdn.example/pic.jpg"]);
    expect(out).toEqual(["https://cdn.example/pic.jpg"]);
  });

  it("混合列表返回严格等长同序（消费方按下标对位的契约）", async () => {
    mocks.backend = { presignGet: vi.fn(async (key: string) => `https://s3.example/${key}`) };
    const input = ["data:image/png;base64,AAA", KEY, "https://cdn.example/pic.jpg"];
    const out = await resolveRefImages(input);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(input[0]);
    expect(out[1]).toBe(`https://s3.example/${KEY}`);
    expect(out[2]).toBe(input[2]);
  });

  it("存储素材读取失败：抛 GenerationFailureError（损坏引用早失败，不喂给上游）", async () => {
    mocks.backend = {};
    mocks.acquire.mockRejectedValue(new StorageTraversalError(KEY));
    await expect(resolveRefImages([KEY])).rejects.toBeInstanceOf(GenerationFailureError);
  });
});
