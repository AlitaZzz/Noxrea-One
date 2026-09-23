import { describe, it, expect } from "vitest";
import { decodeDataUrl } from "./download";

describe("decodeDataUrl", () => {
  it("解码无 mime 声明的 base64 data URL（视频协议层产物）", () => {
    const buf = decodeDataUrl(`data:;base64,${Buffer.from("hello").toString("base64")}`);
    expect(buf?.toString("utf8")).toBe("hello");
  });

  it("解码 image mime 的 base64 data URL", () => {
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const buf = decodeDataUrl(`data:image/png;base64,${raw.toString("base64")}`);
    expect(buf?.equals(raw)).toBe(true);
  });

  it("mime 含特殊字符仍可解码（真实类型由 sniffMime 决定）", () => {
    const raw = Buffer.from("x");
    const buf = decodeDataUrl(`data:application/octet-stream;base64,${raw.toString("base64")}`);
    expect(buf?.equals(raw)).toBe(true);
  });

  it("拒绝非 base64 的 data URL", () => {
    expect(decodeDataUrl("data:text/plain,hello")).toBeNull();
  });

  it("拒绝空的 base64 载荷", () => {
    expect(decodeDataUrl("data:;base64,")).toBeNull();
  });

  it("拒绝缺少 base64 标记的 data URL", () => {
    expect(decodeDataUrl("data:;base64")).toBeNull();
  });

  it("拒绝非 data: 前缀字符串", () => {
    expect(decodeDataUrl("https://example.com/a.png")).toBeNull();
  });
});
