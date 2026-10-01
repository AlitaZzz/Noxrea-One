/**
 * MIME 单一来源回归测试。
 * 锁定：主表全集（含别名）、语境 fallback、扩展名归一化、
 * magic 嗅探（RIFF 二分、ftyp brand 细分修 m4a 误判）。
 */
import { describe, expect, it } from "vitest";
import { mimeByExt, normalizeExt, sniffMime } from "@server/services/storage/mime";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");

describe("mimeByExt", () => {
  it("覆盖全部已知扩展名（含 .wave/.oga/.opus 别名）", () => {
    const cases: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".avif": "image/avif",
      ".mp4": "video/mp4",
      ".m4v": "video/x-m4v",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".avi": "video/x-msvideo",
      ".mkv": "video/x-matroska",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".wave": "audio/wav",
      ".ogg": "audio/ogg",
      ".oga": "audio/ogg",
      ".opus": "audio/ogg",
      ".m4a": "audio/mp4",
      ".aac": "audio/aac",
      ".flac": "audio/flac",
    };
    for (const [ext, mime] of Object.entries(cases)) {
      expect(mimeByExt(ext)).toBe(mime);
    }
  });

  it("avif/avi 不再回退 octet-stream（回归 A4 下载缺陷）", () => {
    expect(mimeByExt(".avif")).toBe("image/avif");
    expect(mimeByExt(".avi")).toBe("video/x-msvideo");
  });

  it("未收录扩展名按语境 fallback，默认 octet-stream", () => {
    expect(mimeByExt(".xyz")).toBe("application/octet-stream");
    expect(mimeByExt(".xyz", "audio/mpeg")).toBe("audio/mpeg");
    expect(mimeByExt(".xyz", "video/mp4")).toBe("video/mp4");
    expect(mimeByExt("")).toBe("application/octet-stream");
  });

  it("归一化：无点 / 大写输入均可命中", () => {
    expect(mimeByExt("mp4")).toBe("video/mp4");
    expect(mimeByExt(".MP4")).toBe("video/mp4");
    expect(mimeByExt(".Mp3")).toBe("audio/mpeg");
    expect(normalizeExt("MP3")).toBe(".mp3");
    expect(normalizeExt(".jpg")).toBe(".jpg");
  });
});

describe("sniffMime", () => {
  it("常见格式 magic bytes", () => {
    expect(sniffMime(hex("ffd8ff")).mime).toBe("image/jpeg");
    expect(sniffMime(hex("89504e47")).mime).toBe("image/png");
    expect(sniffMime(hex("47494638")).mime).toBe("image/gif");
    expect(sniffMime(hex("4f676753")).mime).toBe("audio/ogg");
    expect(sniffMime(hex("664c6143")).mime).toBe("audio/flac");
    expect(sniffMime(hex("494433")).mime).toBe("audio/mpeg");
    expect(sniffMime(hex("fffb")).mime).toBe("audio/mpeg");
    expect(sniffMime(hex("1a45dfa3"))).toEqual({ mime: "video/webm", ext: ".webm" });
  });

  it("RIFF 按第二段区分 WAVE 与 WEBP", () => {
    expect(sniffMime(hex("524946460000000057415645")).mime).toBe("audio/wav");
    expect(sniffMime(hex("524946460000000057454250")).mime).toBe("image/webp");
  });

  it("ftyp 默认判 video/mp4", () => {
    // 00000000 66747970 69736f6d（major brand = isom）
    expect(sniffMime(hex("000000006674797069736f6d"))).toEqual({ mime: "video/mp4", ext: ".mp4" });
  });

  it("ftyp major brand M4A 判音频（回归 m4a 误存 .mp4）", () => {
    // 00000000 66747970 4d344120（major brand = "M4A "）
    expect(sniffMime(hex("00000000667479704d344120"))).toEqual({
      mime: "audio/mp4",
      ext: ".m4a",
    });
  });

  it("未知签名与超短缓冲回退 octet-stream", () => {
    expect(sniffMime(Buffer.from("hello world!"))).toEqual({
      mime: "application/octet-stream",
      ext: ".bin",
    });
    expect(sniffMime(Buffer.alloc(2))).toEqual({
      mime: "application/octet-stream",
      ext: ".bin",
    });
    // 恰好 8 字节的 ftyp 前缀（不足 brand 读取窗口）按默认条目判定
    expect(sniffMime(hex("0000000066747970")).mime).toBe("video/mp4");
  });
});
