/**
 * 请求构建引擎回归测试。
 * 以 server/resources/model-ui.json 真实条目为 fixture，锁定：
 * 白名单过滤、内部字段清除、字段改名/换算、参考槽位按 refMode 分派、
 * 派生字段优先应用、通用字段透传。
 */
import { describe, expect, it } from "vitest";

import { build } from "@server/services/request-builder/engine";

describe("build（engine）", () => {
  it("未知 host 回退 _default：白名单过滤 + 内部字段清除 + 通用字段透传", () => {
    const out = build({
      params: {
        prompt: "p",
        model: "m",
        providerId: 9,
        refMode: "image",
        capability: "x",
        quality: "high",
        seconds: 5, // 不在 image 白名单 → 丢弃
      },
      modelName: "any-model",
      capability: "image",
      protocol: "openai",
      baseUrl: "http://unknown-host.test/v1",
    });

    expect(out).toEqual({ prompt: "p", model: "m", quality: "high" });
  });

  it("_default image 的 refImages 映射为 image_urls 数组", () => {
    const out = build({
      params: { prompt: "p", refImages: ["u1", "u2"] },
      modelName: "any-model",
      capability: "image",
      protocol: "openai",
      baseUrl: "http://unknown-host.test/v1",
    });

    expect(out).toEqual({ prompt: "p", image_urls: ["u1", "u2"] });
  });

  it("apimart gpt-image-2：ratio 改名 size、refImages 改名 image_urls", () => {
    const out = build({
      params: { ratio: "16:9", refImages: ["u1"], prompt: "p" },
      modelName: "gpt-image-2-preview",
      capability: "image",
      protocol: "openai",
      baseUrl: "https://api.apimart.ai/v1",
    });

    expect(out).toEqual({ prompt: "p", size: "16:9", image_urls: ["u1"] });
  });

  it("agnes-video-2.5：派生 mode、首尾帧成对、wrap/stringify 换算", () => {
    const out = build({
      params: {
        refMode: "first-last",
        refImages: ["f", "l"],
        refVideos: ["v1"],
        seconds: 5,
        ratio: "16:9",
        resolution: "720P",
      },
      modelName: "agnes-video-2.5",
      capability: "video",
      protocol: "openai",
      baseUrl: "https://api.agnes-ai.cn/v1",
    });

    expect(out).toEqual({
      mode: "keyframe", // derivedFields：refMode 查表派生
      first_frame: "f", // refImages byRefMode first-last → pair
      last_frame: "l",
      videos: [{ url: "v1" }], // wrap
      seconds: "5", // stringify
      aspect_ratio: "16:9",
      size: "720P",
    });
  });

  it("agnes refMode=image：首帧单值派生；白名单外的 generateAudio 丢弃", () => {
    const out = build({
      params: { refMode: "image", refImages: ["x"], generateAudio: false },
      modelName: "agnes-video-2.5",
      capability: "video",
      protocol: "openai",
      baseUrl: "https://api.agnes-ai.cn/v1",
    });

    expect(out).toEqual({ mode: "keyframe", first_frame: "x" });
  });

  it("agnes refMode=full：全量参考数组", () => {
    const out = build({
      params: { refMode: "full", refImages: ["a", "b"] },
      modelName: "agnes-video-2.5",
      capability: "video",
      protocol: "openai",
      baseUrl: "https://api.agnes-ai.cn/v1",
    });

    expect(out).toEqual({ mode: "reference", images: ["a", "b"] });
  });

  it("无 refMode（text 模式）时参考槽位为空，参考字段不输出", () => {
    const out = build({
      params: { refImages: ["a"], ratio: "16:9" },
      modelName: "agnes-video-2.5",
      capability: "video",
      protocol: "openai",
      baseUrl: "https://api.agnes-ai.cn/v1",
    });

    expect(out).toEqual({ mode: "text", aspect_ratio: "16:9" });
  });
});
