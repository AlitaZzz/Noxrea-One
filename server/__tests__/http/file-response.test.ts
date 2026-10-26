import { describe, expect, it } from "vitest";

import { buildFileResponseHeaders, type FileCachePolicy } from "@server/http/file-response";

const SESSION_PRIVATE: FileCachePolicy = { credential: "session" };

describe("buildFileResponseHeaders", () => {
  it("SVG 使用正确 MIME 并带 sandbox CSP 与 nosniff", () => {
    const headers = buildFileResponseHeaders(".svg", 128, SESSION_PRIVATE);

    expect(headers.get("Content-Type")).toBe("image/svg+xml");
    expect(headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("非 SVG 不添加 SVG 专属安全头", () => {
    const headers = buildFileResponseHeaders(".png", 128, SESSION_PRIVATE);

    expect(headers.get("Content-Type")).toBe("image/png");
    expect(headers.get("Content-Security-Policy")).toBeNull();
    expect(headers.get("X-Content-Type-Options")).toBeNull();
  });

  it("未知扩展名保持 octet-stream，不猜测 MIME", () => {
    expect(buildFileResponseHeaders(".unknown", 1, SESSION_PRIVATE).get("Content-Type"))
      .toBe("application/octet-stream");
  });

  it("avif/avi 落库后下载响应带正确 Content-Type（回归 A4）", () => {
    expect(buildFileResponseHeaders(".avif", 1, SESSION_PRIVATE).get("Content-Type")).toBe("image/avif");
    expect(buildFileResponseHeaders(".avi", 1, SESSION_PRIVATE).get("Content-Type")).toBe("video/x-msvideo");
  });

  it("缓存语义：会话 private，能力凭据按剩余有效期封顶", () => {
    const cacheOf = (policy: FileCachePolicy) =>
      buildFileResponseHeaders(".png", 1, policy).get("Cache-Control");

    expect(cacheOf({ credential: "session" }))
      .toBe("private, max-age=31536000, immutable");
    expect(cacheOf({ credential: "capability", maxAgeSeconds: 42 }))
      .toBe("public, max-age=42, immutable");
    // 非正剩余秒数按 1 秒处理，不输出 max-age=0 / 负数
    expect(cacheOf({ credential: "capability", maxAgeSeconds: 0 }))
      .toBe("public, max-age=1, immutable");
  });

  it("文件响应不输出 Vary / Set-Cookie", () => {
    const headers = buildFileResponseHeaders(".png", 1, { credential: "session" });
    expect(headers.get("Vary")).toBeNull();
    expect(headers.get("Set-Cookie")).toBeNull();
  });
});
