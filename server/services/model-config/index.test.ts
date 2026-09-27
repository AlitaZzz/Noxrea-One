/**
 * 模型配置服务回归测试（真实 model-ui.json / provider-presets.json 为 fixture）。
 * 锁定：host 通配匹配、allowedFields 回退与模型级命中、解析树合并与内部键剥离、
 * 字段默认值提取、text↔llm 归一化、预设结构校验。
 */
import { describe, expect, it } from "vitest";

import {
  buildResolvedClientTree,
  getAllowedFields,
  getModelParams,
  hostFromBaseUrl,
  loadPresets,
  modelFieldDefaults,
  normalizeCapability,
  resolveMatchedHost,
} from "./index";

describe("host 解析", () => {
  it("hostFromBaseUrl 剥离协议、端口保留、路径忽略", () => {
    expect(hostFromBaseUrl("https://api.apimart.ai/v1")).toBe("api.apimart.ai");
    expect(hostFromBaseUrl("http://192.168.1.9:8000/")).toBe("192.168.1.9");
  });

  it("resolveMatchedHost 通配命中与 _default 回退", () => {
    expect(resolveMatchedHost("https://api.apimart.ai/v1")).toBe("*apimart*");
    expect(resolveMatchedHost("https://no-match.example.com")).toBe("_default");
  });
});

describe("能力归一化", () => {
  it("text → llm（web/DB 层词汇到服务端能力名）", () => {
    expect(normalizeCapability("text")).toBe("llm");
    expect(normalizeCapability("image")).toBe("image");
  });
});

describe("getAllowedFields", () => {
  it("未知 host 回退 _default 的能力白名单", () => {
    expect(getAllowedFields("unknown.test", "m", "image")).toEqual([
      "quality", "resolution", "ratio", "n", "refImages",
    ]);
  });

  it("模型级条目命中：agnes-video-2.5 的 video 白名单", () => {
    expect(getAllowedFields("api.agnes-ai.cn", "agnes-video-2.5", "video")).toEqual([
      "ratio", "resolution", "seconds", "refImages", "refVideos", "refAudios", "refMode",
    ]);
  });

  it("text 经归一化后取 llm 白名单", () => {
    expect(getAllowedFields("unknown.test", "m", "text")).toEqual(["messages", "stream"]);
  });
});

describe("getModelParams / modelFieldDefaults", () => {
  it("模型级字段默认值提取", () => {
    const params = getModelParams("api.agnes-ai.cn", "agnes-video-2.5", "video");
    expect(params).not.toBeNull();
    expect(modelFieldDefaults(params)).toEqual({ ratio: "16:9", resolution: "720P", seconds: 5 });
  });

  it("refMode 能力声明透出", () => {
    const params = getModelParams("*apimart*", "MiniMax-H3", "video");
    expect(params?.capabilities?.refMode?.options).toEqual(["text", "image", "first-last", "full"]);
  });
});

describe("buildResolvedClientTree", () => {
  it("内部键剥离、_default 保留、模型级与 _default 合并", () => {
    const tree = buildResolvedClientTree();

    expect(Object.keys(tree)).toContain("_default");
    expect(Object.keys(tree)).toContain("*apimart*");
    const apimart = tree["*apimart*"] as Record<string, Record<string, unknown>>;
    expect(apimart["_comment"]).toBeUndefined();
    expect(apimart["_endpoints"]).toBeUndefined();

    // 模型级无 allowedFields，与 _default 合并后继承
    const gptImage = apimart["*gpt-image-2*"] as Record<string, { allowedFields?: string[] }>;
    expect(gptImage.image.allowedFields).toEqual([
      "quality", "resolution", "ratio", "n", "refImages",
    ]);
  });
});

describe("loadPresets", () => {
  it("真实预设文件通过结构校验", () => {
    const presets = loadPresets();
    expect(Array.isArray(presets)).toBe(true);
    expect(presets.length).toBeGreaterThan(0);
    for (const p of presets) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.baseUrl).toBe("string");
    }
  });
});
