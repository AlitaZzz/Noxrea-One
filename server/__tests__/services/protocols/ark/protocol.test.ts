/**
 * Ark 协议回归测试。
 * 锁定：请求构造（URL/头/体）、同步产物解析换用 parseScanSyncResult 后的
 * 行为（data[].url 原路径保留 + 整树扫描 + 裸 base64 兜底）。
 */
import { describe, expect, it } from "vitest";

import { ArkImageProtocol } from "@server/services/protocols/ark/image";
import { ArkVideoProtocol } from "@server/services/protocols/ark/video";

describe("ArkImageProtocol", () => {
  const proto = new ArkImageProtocol();

  it("buildImageRequest：默认 generations 端点 + Bearer 头", () => {
    const req = proto.buildImageRequest("http://ark.test", "key-1", { prompt: "p", model: "m" });
    expect(req).toEqual({
      url: "http://ark.test/v1/images/generations",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer key-1" },
      body: { prompt: "p", model: "m" },
    });
  });

  it("buildImageRequest：渠道 endpoints 配置可覆盖端点", () => {
    const req = proto.buildImageRequest(
      "http://ark.test",
      "key-1",
      { prompt: "p" },
      { protocol: { endpoints: { "image.generations": "/v1/custom-images" } } }
    );
    expect(req.url).toBe("http://ark.test/v1/custom-images");
  });

  it("parseImageResponse：data[].url 提取（原行为保留）", () => {
    const result = proto.parseImageResponse({
      data: [{ url: "https://cdn.test/a.png" }, { url: "https://cdn.test/b.png" }],
    });
    expect(result.urls).toEqual(["https://cdn.test/a.png", "https://cdn.test/b.png"]);
  });

  it("parseImageResponse：裸 b64_json 兜底补 data: 前缀", () => {
    const result = proto.parseImageResponse({
      data: [{ b64_json: "aGVsbG8=" }],
    });
    expect(result.urls).toEqual(["data:image/png;base64,aGVsbG8="]);
  });

  it("parseImageResponse：无产物返回空数组", () => {
    expect(proto.parseImageResponse({ data: [] }).urls).toEqual([]);
    expect(proto.parseImageResponse({}).urls).toEqual([]);
  });
});

describe("ArkVideoProtocol", () => {
  const proto = new ArkVideoProtocol();

  it("buildVideoRequest：固定 video/generations 端点 + Bearer 头", () => {
    const req = proto.buildVideoRequest("http://ark.test", "key-1", { prompt: "p" });
    expect(req).toEqual({
      url: "http://ark.test/v1/video/generations",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer key-1" },
      body: { prompt: "p" },
    });
  });

  it("parseVideoResponse：data[].url 提取（原行为保留）", () => {
    const result = proto.parseVideoResponse({
      data: [{ url: "https://cdn.test/v.mp4" }],
    });
    expect(result.urls).toEqual(["https://cdn.test/v.mp4"]);
  });

  it("parseVideoResponse：嵌套字段中的 URL 也能整树扫出（parseScanSyncResult 超集能力）", () => {
    const result = proto.parseVideoResponse({
      data: [{ video: { download_url: "https://cdn.test/v2.mp4" } }],
    });
    expect(result.urls).toEqual(["https://cdn.test/v2.mp4"]);
  });
});
