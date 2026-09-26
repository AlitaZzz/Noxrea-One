import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("@server/core/config", () => ({
  getConfig: () => ({
    UPLOAD_DIR: "uploads",
    FFMPEG_PATH: "ffmpeg",
    FFPROBE_PATH: "ffprobe",
    LOG_LEVEL: "debug",
    ALLOW_INSECURE_SECRETS: true,
  }),
}));

import { localStorage } from "./backends/local";
import { getResizedWebP, getVideoPosterWebP } from "./resize-cache";

let tmpDir = "";

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "media-guard-"));
  (localStorage as { baseDir: string }).baseDir = tmpDir;
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
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

  it("base 内合法 key 正常生成缩放缓存", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await fs.mkdir(path.join(tmpDir, "u1/ab"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "u1/ab/ok.png"), png);

    const cached = await getResizedWebP("u1/ab/ok.png", 4);
    expect(cached).toBe("_cache/4/u1/ab/ok.webp");
    await expect(
      fs.stat(path.join(tmpDir, "_cache/4/u1/ab/ok.webp"))
    ).resolves.toBeTruthy();
  });
});
