import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());
vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));

import { decodeDataUrl, fetchMediaBytes, identifyMediaBytes } from "@server/services/storage/download";
import { resetTestSettings } from "../../helpers/settings";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(() => {
  resetTestSettings();
});

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

  it("载荷混入字母表之外的文本（粘连下一段地址）→ 拒绝，不解码成垃圾字节", () => {
    expect(decodeDataUrl("data:;base64,AAAA,https://example.com/x.png")).toBeNull();
  });

  it("载荷中的 MIME 换行被剔除后完整解码", () => {
    const raw = Buffer.from("hello world");
    const wrapped = raw.toString("base64").replace(/(.{4})/g, "$1\n");
    expect(decodeDataUrl(`data:;base64,${wrapped}`)?.equals(raw)).toBe(true);
  });

  it("载荷尾部空白不影响解码", () => {
    expect(decodeDataUrl("data:;base64,AAAA ")?.length).toBe(3);
  });
});

describe("fetchMediaBytes（data URL）", () => {
  it("解码并返回原始字节", async () => {
    const raw = Buffer.concat([PNG_SIGNATURE, Buffer.from("payload")]);
    const buf = await fetchMediaBytes(`data:image/png;base64,${raw.toString("base64")}`);
    expect(buf?.equals(raw)).toBe(true);
  });

  it("超过 upload.max_file_mb 的载荷被拒绝（与远端下载同一上限）", async () => {
    resetTestSettings({ "upload.max_file_mb": 1 });
    const payload = Buffer.alloc(1_100_000, 7).toString("base64");
    expect(await fetchMediaBytes(`data:;base64,${payload}`)).toBeNull();
  });

  it("非 base64 的 data URL 返回 null（不抛错）", async () => {
    expect(await fetchMediaBytes("data:text/plain,hello")).toBeNull();
  });
});

describe("identifyMediaBytes", () => {
  it("同字节必得同 key，不同字节不同 key（key 即内容身份）", async () => {
    const same = Buffer.concat([PNG_SIGNATURE, Buffer.from([1, 2, 3])]);
    const other = Buffer.concat([PNG_SIGNATURE, Buffer.from([9])]);

    const a = await identifyMediaBytes(same, 7);
    const b = await identifyMediaBytes(Buffer.from(same), 7);
    const c = await identifyMediaBytes(other, 7);

    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
    expect(a.key.startsWith("7/")).toBe(true);
    expect(a.key.endsWith(".png")).toBe(true);
    expect(a.mimeType).toBe("image/png");
  });
});
