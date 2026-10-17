import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const cfg = vi.hoisted(() => ({ uploadDir: "uploads" }));

vi.mock("@server/core/config", () => ({
  getConfig: () => ({
    UPLOAD_DIR: cfg.uploadDir,
    FFMPEG_PATH: "ffmpeg",
    FFPROBE_PATH: "ffprobe",
    LOG_LEVEL: "debug",
    ALLOW_INSECURE_SECRETS: true,
  }),
}));

vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());

import { getResizedWebP, getVideoPosterWebP, normalizeResizeWidth } from "@server/services/storage/resize-cache";
import { initStorageBackend } from "@server/services/storage/service";
import { LocalStorageBackend } from "@server/services/storage/backends/local";
import { acquireMediaSlot } from "@server/services/storage/media-pool";
import { resetTestSettings } from "../../helpers/settings";

let tmpDir = "";

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "media-guard-"));
  // 后端与工作区根都锚定隔离目录：uploadRoot() 惰性读 config，beforeAll 落定即可
  cfg.uploadDir = tmpDir;
  initStorageBackend(new LocalStorageBackend(tmpDir));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("缩略图宽度档位（specs/media-processing-concurrency.md 规则 8）", () => {
  it("请求宽度向上取档，超过最大档一律最大档", () => {
    expect(normalizeResizeWidth(1)).toBe(64);
    expect(normalizeResizeWidth(64)).toBe(64);
    expect(normalizeResizeWidth(100)).toBe(112);
    expect(normalizeResizeWidth(130)).toBe(200);
    expect(normalizeResizeWidth(480)).toBe(480);
    expect(normalizeResizeWidth(500)).toBe(1280);
    expect(normalizeResizeWidth(2048)).toBe(1280);
  });

  it("超档宽度在缓存键层归一化：500 → 1280 档落盘", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "green" } }).png().toBuffer();
    await fs.mkdir(path.join(tmpDir, "u1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "u1/ab/w500.png"), png);

    const cached = await getResizedWebP("u1/ab/w500.png", 500);
    expect(cached).toBe("_cache/1280/u1/ab/w500.webp");
    await expect(fs.stat(path.join(tmpDir, "_cache/1280/u1/ab/w500.webp"))).resolves.toBeTruthy();
  });

  it("缩放缓存键使用归一化后的档位", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await fs.mkdir(path.join(tmpDir, "u1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "u1/ab/ok.png"), png);

    const cached = await getResizedWebP("u1/ab/ok.png", 4);
    expect(cached).toBe("_cache/64/u1/ab/ok.webp");
    await expect(
      fs.stat(path.join(tmpDir, "_cache/64/u1/ab/ok.webp"))
    ).resolves.toBeTruthy();
  });
});

describe("缩放缓存路径守卫（存储层自带）", () => {
  it.each(["/etc/x.png", "../outside.png", "a/../../outside.png"])(
    "图片缩放拒绝越界 key：%s",
    async (key) => {
      await expect(getResizedWebP(key, 100)).resolves.toBeNull();
    }
  );

  it.each(["/etc/x.mp4", "../outside.mp4"])(
    "视频海报拒绝越界 key：%s",
    async (key) => {
      await expect(getVideoPosterWebP(key, 100)).resolves.toBeNull();
    }
  );
});

describe("缩放与媒体池", () => {
  afterEach(() => resetTestSettings());

  it("sharp 池过载时向上抛 MediaPoolBusyError，而不是静默返回 null", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    await fs.mkdir(path.join(tmpDir, "u1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "u1/ab/busy.png"), png);

    resetTestSettings({ "media.sharp_max_pending": 0 });
    const a = await acquireMediaSlot("sharp");
    const b = await acquireMediaSlot("sharp");
    try {
      await expect(getResizedWebP("u1/ab/busy.png", 4)).rejects.toMatchObject({
        name: "MediaPoolBusyError",
        pool: "sharp",
        scope: "global",
      });
    } finally {
      a();
      b();
    }

    await expect(getResizedWebP("u1/ab/busy.png", 4)).resolves.toBe("_cache/64/u1/ab/busy.webp");
  });

  it("轻型池过载时视频海报向上抛 MediaPoolBusyError（ffmpeg 尚未启动），且不留临时文件", async () => {
    resetTestSettings({ "media.ffmpeg_light_max_pending": 0 });
    const a = await acquireMediaSlot("ffmpeg_light");
    const b = await acquireMediaSlot("ffmpeg_light");
    try {
      await expect(getVideoPosterWebP("u1/ab/clip.mp4", 4)).rejects.toMatchObject({
        name: "MediaPoolBusyError",
        pool: "ffmpeg_light",
        scope: "global",
      });
    } finally {
      a();
      b();
    }

    await expect(fs.readdir(path.join(tmpDir, "_tmp"))).resolves.toEqual([]);
  });

  it("生成失败（源文件不存在）后释放 sharp 槽位", async () => {
    resetTestSettings({ "media.sharp_max_pending": 0 });
    await expect(getResizedWebP("u1/ab/missing.png", 4)).resolves.toBeNull();

    // 上限 2、队列 0：两次都能立即取到说明失败路径没有泄漏槽位
    const a = await acquireMediaSlot("sharp");
    const b = await acquireMediaSlot("sharp");
    a();
    b();
  });
});
