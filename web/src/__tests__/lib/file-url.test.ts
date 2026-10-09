import { describe, expect, it } from "vitest";

import { isManagedFileUrl, withManagedFileWidth } from "@/lib/file-url";

describe("managed file URLs", () => {
  it("识别托管文件并设置缩略宽度", () => {
    expect(isManagedFileUrl("/api/files/abc.png")).toBe(true);
    const result: string = withManagedFileWidth("/api/files/abc.png", 320);
    expect(result).toBe("/api/files/abc.png?w=320");
  });

  it("保留已有查询参数和 hash", () => {
    expect(withManagedFileWidth("/api/files/abc.png?download=1#preview", 480)).toBe(
      "/api/files/abc.png?download=1&w=480#preview"
    );
  });

  it("外部 URL 和空值不添加缩略参数", () => {
    expect(isManagedFileUrl("https://cdn.example.com/abc.png")).toBe(false);
    expect(withManagedFileWidth("https://cdn.example.com/abc.png", 320)).toBe("https://cdn.example.com/abc.png");
    expect(withManagedFileWidth(undefined, 320)).toBeUndefined();
  });

  it("忽略查询串、hash 和 data URL 中出现的托管路径片段", () => {
    const queryUrl = "https://cdn.example.com/abc.png?source=/api/files/original.png";
    const hashUrl = "https://cdn.example.com/abc.png#/api/files/original.png";
    const dataUrl = "data:text/plain,/api/files/original.png";

    expect(isManagedFileUrl(queryUrl)).toBe(false);
    expect(isManagedFileUrl(hashUrl)).toBe(false);
    expect(isManagedFileUrl(dataUrl)).toBe(false);
    expect(withManagedFileWidth(queryUrl, 320)).toBe(queryUrl);
    expect(withManagedFileWidth(hashUrl, 320)).toBe(hashUrl);
    expect(withManagedFileWidth(dataUrl, 320)).toBe(dataUrl);
  });

  it("识别绝对托管文件 URL 的 pathname", () => {
    const url = "https://cdn.example.com/api/files/abc.png?download=1";

    expect(isManagedFileUrl(url)).toBe(true);
    expect(withManagedFileWidth(url, 320)).toBe("https://cdn.example.com/api/files/abc.png?download=1&w=320");
  });
});
