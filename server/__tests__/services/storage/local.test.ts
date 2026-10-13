/**
 * 本地存储后端的原子落盘：临时文件集中在 _tmp 且保留目标文件名、失败清理、内容寻址去重，
 * 以及启动时清空临时目录。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("@server/core/config", () => ({
  getConfig: () => ({ UPLOAD_DIR: "uploads", LOG_LEVEL: "silent", ALLOW_INSECURE_SECRETS: true }),
}));

import { LocalStorageBackend } from "@server/services/storage/backends/local";

let root = "";
let storage: LocalStorageBackend;
const abs = (key: string) => path.join(root, key);
const tmpEntries = () => fs.readdir(path.join(root, "_tmp")).catch(() => [] as string[]);

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "local-storage-"));
  storage = new LocalStorageBackend(root);
});
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("LocalStorageBackend.writeAtomic", () => {
  it("写入 _tmp 下以目标文件名结尾的临时文件，成功后改名就位且不留临时文件", async () => {
    let seenTmp = "";
    await storage.writeAtomic("u1/ab/clip.mp4", async (tmpPath) => {
      seenTmp = tmpPath;
      await fs.writeFile(tmpPath, "video");
    });

    expect(path.dirname(seenTmp)).toBe(path.join(root, "_tmp"));
    expect(path.basename(seenTmp).endsWith(".clip.mp4")).toBe(true);
    expect(await fs.readFile(abs("u1/ab/clip.mp4"), "utf8")).toBe("video");
    expect(await tmpEntries()).toEqual([]);
  });

  it("写入失败时清理临时文件，已有目标保持原样", async () => {
    await fs.mkdir(path.dirname(abs("u1/ab/keep.webp")), { recursive: true });
    await fs.writeFile(abs("u1/ab/keep.webp"), "old");

    await expect(storage.writeAtomic("u1/ab/keep.webp", async (tmpPath) => {
      await fs.writeFile(tmpPath, "partial");
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(await fs.readFile(abs("u1/ab/keep.webp"), "utf8")).toBe("old");
    expect(await tmpEntries()).toEqual([]);
  });

  it("拒绝逃出存储根的 key", async () => {
    await expect(storage.writeAtomic("../outside.bin", async () => undefined)).rejects.toThrow(/Path traversal/);
  });
});

describe("LocalStorageBackend.save", () => {
  it("Buffer 与文件路径来源都经原子落盘写入目标，不留临时文件", async () => {
    await storage.save("u2/cd/from-buffer.png", Buffer.from("buffer"));

    const source = path.join(root, "source.bin");
    await fs.writeFile(source, "from-path");
    await storage.save("u2/cd/from-path.bin", source);

    expect(await fs.readFile(abs("u2/cd/from-buffer.png"), "utf8")).toBe("buffer");
    expect(await fs.readFile(abs("u2/cd/from-path.bin"), "utf8")).toBe("from-path");
    expect(await fs.readFile(source, "utf8")).toBe("from-path");
    expect(await tmpEntries()).toEqual([]);
  });

  it("内容寻址去重：目标已存在且大小一致时跳过写盘", async () => {
    await fs.mkdir(path.dirname(abs("u2/cd/same.bin")), { recursive: true });
    await fs.writeFile(abs("u2/cd/same.bin"), "AAAA");

    await storage.save("u2/cd/same.bin", Buffer.from("BBBB"));

    expect(await fs.readFile(abs("u2/cd/same.bin"), "utf8")).toBe("AAAA");
  });
});

describe("LocalStorageBackend.clearTmpDir", () => {
  it("清空临时目录及其中残留（崩溃前进行中的写入）", async () => {
    await fs.mkdir(path.join(root, "_tmp", "clip_leftover"), { recursive: true });
    await fs.writeFile(path.join(root, "_tmp", "leftover.webp"), "x");

    await storage.clearTmpDir();

    await expect(fs.access(path.join(root, "_tmp"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("LocalStorageBackend.delete 派生产物清理", () => {
  it("删除源文件时按前缀清掉其缩略图档位与海报母版，并回收空目录", async () => {
    await fs.mkdir(path.join(root, "u9/ef"), { recursive: true });
    await fs.writeFile(path.join(root, "u9/ef/clip.mp4"), "video");
    for (const p of [
      "_cache/64/u9/ef/clip.webp",
      "_cache/480/u9/ef/clip.webp",
      "_posters/v1/u9/ef/clip.webp",
      // 其他源的派生文件不受影响
      "_cache/64/u9/ef/other.webp",
    ]) {
      await fs.mkdir(path.dirname(abs(p)), { recursive: true });
      await fs.writeFile(abs(p), "derived");
    }

    await storage.delete("u9/ef/clip.mp4");

    await expect(fs.access(abs("u9/ef/clip.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(abs("_cache/64/u9/ef/clip.webp"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(abs("_cache/480/u9/ef/clip.webp"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(abs("_posters/v1/u9/ef/clip.webp"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(abs("_cache/64/u9/ef/other.webp"))).resolves.toBeUndefined();
    // 清空的分组目录被回收
    await expect(fs.access(abs("_posters/v1"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("派生根不存在时不报错", async () => {
    await fs.mkdir(path.dirname(abs("u9/ef/plain.bin")), { recursive: true });
    await fs.writeFile(abs("u9/ef/plain.bin"), "x");

    await expect(storage.delete("u9/ef/plain.bin")).resolves.toBeUndefined();
  });
});
