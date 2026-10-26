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

import { normalizeResizeWidth } from "@noxrea/shared/media-tiers";
import { getResizedWebP, getVideoPosterWebP, isAnimatedPng } from "@server/services/storage/resize-cache";
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

describe("缩略图宽度档位（specs/canvas-media-resolution-lod.md 规则 4）", () => {
  it("请求宽度向上取档，超过最大档一律最大档", () => {
    expect(normalizeResizeWidth(1)).toBe(64);
    expect(normalizeResizeWidth(64)).toBe(64);
    expect(normalizeResizeWidth(100)).toBe(112);
    expect(normalizeResizeWidth(130)).toBe(200);
    expect(normalizeResizeWidth(480)).toBe(480);
    // 行为变更锁定：新 12 档表不再把 500→1280、2048→1280
    expect(normalizeResizeWidth(500)).toBe(640);
    expect(normalizeResizeWidth(640)).toBe(640);
    expect(normalizeResizeWidth(1281)).toBe(1920);
    expect(normalizeResizeWidth(2048)).toBe(2560);
    expect(normalizeResizeWidth(99999)).toBe(2560);
  });

  it("超档宽度在缓存键层归一化：500 → 640 档落盘（v2 命名空间）", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "green" } }).png().toBuffer();
    await fs.mkdir(path.join(tmpDir, "u1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "u1/ab/w500.png"), png);

    const cached = await getResizedWebP("u1/ab/w500.png", 500);
    expect(cached).toBe("_cache/v2/640/u1/ab/w500.webp");
    await expect(fs.stat(path.join(tmpDir, "_cache/v2/640/u1/ab/w500.webp"))).resolves.toBeTruthy();
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
    expect(cached).toBe("_cache/v2/64/u1/ab/ok.webp");
    await expect(
      fs.stat(path.join(tmpDir, "_cache/v2/64/u1/ab/ok.webp"))
    ).resolves.toBeTruthy();
  });
});

describe("EXIF 方向（specs/canvas-media-resolution-lod.md 规则 8.2）", () => {
  it("autoOrient 在 resize 前执行：Orientation=6 输出按显示方向", async () => {
    const sharp = (await import("sharp")).default;
    const jpeg = await sharp({
      create: { width: 40, height: 20, channels: 3, background: "yellow" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    await fs.mkdir(path.join(tmpDir, "u1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "u1/ab/exif.jpg"), jpeg);

    const cached = await getResizedWebP("u1/ab/exif.jpg", 64);
    expect(cached).toBe("_cache/v2/64/u1/ab/exif.webp");
    // 经 Buffer 读取而不是 sharp(path)：libvips 的 native 句柄在 Windows 上会锁文件，
    // 导致 afterAll 清理临时目录时 EBUSY（与生产代码规避路径句柄的理由相同）
    const meta = await sharp(await fs.readFile(path.join(tmpDir, cached!))).metadata();
    expect(meta.width).toBe(20);
    expect(meta.height).toBe(40);
  });
});

describe("APNG 识别（specs/canvas-media-resolution-lod.md 规则 8.8）", () => {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    return Buffer.concat([length, Buffer.from(type, "ascii"), data, crc]);
  }
  function pngWith(chunks: Array<[string, Buffer?]>): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
      PNG_SIGNATURE,
      pngChunk("IHDR", ihdr),
      ...chunks.map(([type, data]) => pngChunk(type, data)),
    ]);
  }

  it("首个 IDAT 前的 acTL 判定为 APNG，不生成静态档位", async () => {
    await fs.mkdir(path.join(tmpDir, "u1/ab"), { recursive: true });
    const file = path.join(tmpDir, "u1/ab/anim.png");
    await fs.writeFile(file, pngWith([["acTL", Buffer.alloc(8)], ["IDAT", Buffer.from([0])]]));

    await expect(isAnimatedPng(file)).resolves.toBe(true);
    await expect(getResizedWebP("u1/ab/anim.png", 64)).resolves.toBeNull();
    await expect(fs.stat(path.join(tmpDir, "_cache/v2/64/u1/ab/anim.webp"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("普通 PNG 与 IDAT 之后的 acTL 都不是 APNG", async () => {
    const sharp = (await import("sharp")).default;
    const plain = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    await fs.mkdir(path.join(tmpDir, "u1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "u1/ab/plain.png"), plain);
    await expect(isAnimatedPng(path.join(tmpDir, "u1/ab/plain.png"))).resolves.toBe(false);

    const late = path.join(tmpDir, "u1/ab/late.png");
    await fs.writeFile(late, pngWith([["IDAT", Buffer.from([0])], ["acTL", Buffer.alloc(8)]]));
    await expect(isAnimatedPng(late)).resolves.toBe(false);
  });

  it("畸形 chunk 长度不会死循环，按非 APNG 处理", async () => {
    await fs.mkdir(path.join(tmpDir, "u1/ab"), { recursive: true });
    const file = path.join(tmpDir, "u1/ab/malformed.png");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(0xffffffff, 0);
    await fs.writeFile(file, Buffer.concat([PNG_SIGNATURE, length, Buffer.from("junk", "ascii")]));

    await expect(isAnimatedPng(file)).resolves.toBe(false);
    await expect(getResizedWebP("u1/ab/malformed.png", 64)).resolves.toBeNull();
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

    await expect(getResizedWebP("u1/ab/busy.png", 4)).resolves.toBe("_cache/v2/64/u1/ab/busy.webp");
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
