import { describe, expect, it } from "vitest";

import { buildFileResponseHeaders } from "./file-response";

describe("buildFileResponseHeaders", () => {
  it("SVG 使用正确 MIME 并带 sandbox CSP 与 nosniff", () => {
    const headers = buildFileResponseHeaders(".svg", 128);

    expect(headers.get("Content-Type")).toBe("image/svg+xml");
    expect(headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("非 SVG 不添加 SVG 专属安全头", () => {
    const headers = buildFileResponseHeaders(".png", 128);

    expect(headers.get("Content-Type")).toBe("image/png");
    expect(headers.get("Content-Security-Policy")).toBeNull();
    expect(headers.get("X-Content-Type-Options")).toBeNull();
  });

  it("未知扩展名保持 octet-stream，不猜测 MIME", () => {
    expect(buildFileResponseHeaders(".unknown", 1).get("Content-Type"))
      .toBe("application/octet-stream");
  });
});
