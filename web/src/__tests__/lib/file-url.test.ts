import { describe, expect, it } from "vitest";

import { managedFileUrl, withManagedFileWidth } from "@/lib/file-url";

const HASH = "a".repeat(64);
const KEY = `1/${HASH.slice(0, 2)}/${HASH}.png`;

describe("storage key 派生访问 URL（持久化值域的唯一出口）", () => {
  it("key 派生 /api/files/{key}", () => {
    expect(managedFileUrl(KEY)).toBe(`/api/files/${KEY}`);
  });

  it("key 设置缩略宽度时先派生再拼参数（派生版本已内嵌在对象 key）", () => {
    expect(withManagedFileWidth(KEY, 320)).toBe(`/api/files/${KEY}?w=320`);
  });

  it("data:、blob: 与外部 URL 原样透传", () => {
    expect(managedFileUrl("data:image/png;base64,xxx")).toBe("data:image/png;base64,xxx");
    expect(managedFileUrl("blob:https://example.com/x")).toBe("blob:https://example.com/x");
    expect(managedFileUrl("https://cdn.example.com/abc.png")).toBe("https://cdn.example.com/abc.png");
  });
});

describe("managed file URLs", () => {
  it("识别托管文件并设置缩略宽度", () => {
    const result: string = withManagedFileWidth("/api/files/abc.png", 320);
    expect(result).toBe("/api/files/abc.png?w=320");
  });

  it("保留已有查询参数和 hash", () => {
    expect(withManagedFileWidth("/api/files/abc.png?download=1#preview", 480)).toBe(
      "/api/files/abc.png?download=1&w=480#preview"
    );
  });

  it("外部 URL 和空值不添加缩略参数", () => {
    expect(withManagedFileWidth("https://cdn.example.com/abc.png", 320)).toBe("https://cdn.example.com/abc.png");
    expect(withManagedFileWidth(undefined, 320)).toBeUndefined();
  });

  it("忽略查询串、hash 和 data URL 中出现的托管路径片段", () => {
    const queryUrl = "https://cdn.example.com/abc.png?source=/api/files/original.png";
    const hashUrl = "https://cdn.example.com/abc.png#/api/files/original.png";
    const dataUrl = "data:text/plain,/api/files/original.png";

    expect(withManagedFileWidth(queryUrl, 320)).toBe(queryUrl);
    expect(withManagedFileWidth(hashUrl, 320)).toBe(hashUrl);
    expect(withManagedFileWidth(dataUrl, 320)).toBe(dataUrl);
  });

  it("绝对 URL 不是托管值：外部源的同形路径原样透传，不改写成站内地址", () => {
    // 托管值只有站内相对路径一种形态（服务端 buildManagedFileUrl 的产出）。
    // 按路径前缀把别的源认成托管值，会把外部引用改写成 /api/files/… 而失效。
    const url = "https://cdn.example.com/api/files/abc.png?download=1";

    expect(withManagedFileWidth(url, 320)).toBe(url);
    expect(withManagedFileWidth("/api/files/abc.png?download=1", 320)).toBe("/api/files/abc.png?download=1&w=320");
  });

  it("托管前缀必须位于 pathname 起点（前缀后的其他路径不是托管文件）", () => {
    const url = "https://cdn.example.com/proxy/api/files/abc.png";

    expect(withManagedFileWidth(url, 320)).toBe(url);
    expect(withManagedFileWidth("/proxy/api/files/abc.png", 320)).toBe("/proxy/api/files/abc.png");
  });
});
