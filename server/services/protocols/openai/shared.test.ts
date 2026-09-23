/**
 * OpenAI 协议共享解析核心测试。
 * 产物提取为整树 URL 扫描（上游返回结构不可控的有意设计），
 * 重点覆盖：prompt 回显跳过、失败状态优先、base64 兜底与 task_id 提取。
 */
import { describe, expect, it } from "vitest";

import {
  extractB64Fields,
  extractOpenAiTaskId,
  normalizeStatus,
  parseScanPollResult,
  parseScanSyncResult,
  scanUrls,
} from "@server/services/protocols/openai/shared";

const IMAGE_B64 = "data:image/png;base64,";
const VIDEO_B64 = "data:;base64,";

describe("normalizeStatus", () => {
  it("pending 类 / completed 类 / failed 类归一化，未知值原样返回", () => {
    expect(normalizeStatus("Running")).toBe("pending");
    expect(normalizeStatus(" succeeded ")).toBe("completed");
    expect(normalizeStatus("CANCELLED")).toBe("failed");
    expect(normalizeStatus("75%")).toBe("75%");
  });
});

describe("scanUrls", () => {
  it("穿透任意层级收集 https 与 data URL 并去重", () => {
    const urls = scanUrls({
      data: [{ url: "https://a.example/x.png" }, { url: "https://a.example/x.png" }],
      nested: { deep: ["https://b.example/y.mp4"] },
      raw: "data:image/png;base64,AAAA",
    });
    // 扫描正则在 ; , 等分隔符处截断（data URI 的 base64 段由 extractB64Fields 按字段名兜底）
    expect(urls).toEqual([
      "https://a.example/x.png",
      "https://b.example/y.mp4",
      "data:image/png",
    ]);
  });

  it("键名为 prompt/prompts 的值不参与扫描（请求回显非产物）", () => {
    expect(scanUrls({ prompt: "参考 https://img.example.com/cat.png 生成" })).toEqual([]);
    expect(scanUrls({ prompts: ["https://img.example.com/dog.png"] })).toEqual([]);
    expect(scanUrls({ data: [{ prompt: "https://img.example.com/cat.png", url: "https://cdn.example.com/out.png" }] }))
      .toEqual(["https://cdn.example.com/out.png"]);
  });

  it("URL 尾部 ASCII 标点被剔除", () => {
    expect(scanUrls({ msg: "详见 https://policy.example.com/rules?id=1." })).toEqual([
      "https://policy.example.com/rules?id=1",
    ]);
  });
});

describe("extractB64Fields", () => {
  it("按 b64_json / b64 字段名递归定位并补前缀", () => {
    const out = extractB64Fields({ data: [{ b64_json: "AAAABBBB" }, { b64: "CCCC" }] }, IMAGE_B64);
    expect(out).toEqual(["data:image/png;base64,AAAABBBB", "data:image/png;base64,CCCC"]);
  });

  it("已带 data: 前缀的值原样保留", () => {
    expect(extractB64Fields({ b64_json: "data:image/jpeg;base64,ZZZZ" }, IMAGE_B64))
      .toEqual(["data:image/jpeg;base64,ZZZZ"]);
  });
});

describe("parseScanPollResult", () => {
  it("非对象响应 → pending", () => {
    expect(parseScanPollResult("oops", IMAGE_B64)).toEqual({ status: "pending", urls: [] });
  });

  it("扫描到产物 URL → completed", () => {
    const r = parseScanPollResult({ status: "succeeded", data: [{ url: "https://cdn.example.com/a.png" }] }, IMAGE_B64);
    expect(r.status).toBe("completed");
    expect(r.urls).toEqual(["https://cdn.example.com/a.png"]);
  });

  it("failed 状态优先：错误详情里的 URL 不判成产物", () => {
    const r = parseScanPollResult(
      { status: "failed", error: { message: "审核未通过，详见 https://policy.example.com/rules?id=1" } },
      IMAGE_B64
    );
    expect(r.status).toBe("failed");
    expect(r.urls).toEqual([]);
    expect(r.error).toContain("审核未通过");
  });

  it("failed 状态下错误对象取 message，字符串直接用，限长 200", () => {
    expect(parseScanPollResult({ status: "failed", message: "x".repeat(500) }, IMAGE_B64).error).toHaveLength(200);
    expect(parseScanPollResult({ status: "failed", error: "boom" }, IMAGE_B64).error).toBe("boom");
  });

  it("裸 b64_json 兜底合并进产物（image 补 PNG 前缀）", () => {
    const r = parseScanPollResult({ data: [{ b64_json: "AAAABBBBCCCC" }] }, IMAGE_B64);
    expect(r.status).toBe("completed");
    expect(r.urls).toEqual(["data:image/png;base64,AAAABBBBCCCC"]);
  });

  it("视频 b64 补通用前缀", () => {
    const r = parseScanPollResult({ b64: "ZZZZ" }, VIDEO_B64);
    expect(r.urls).toEqual(["data:;base64,ZZZZ"]);
  });
});

describe("parseScanSyncResult", () => {
  it("扫描提交响应中的产物 URL", () => {
    const r = parseScanSyncResult(
      { created: 1, data: [{ url: "https://cdn.example.com/a.png" }, { url: "https://cdn.example.com/b.png" }] },
      IMAGE_B64
    );
    expect(r.urls).toEqual(["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"]);
  });

  it("无 URL 的提交回执 → 空 urls，交由任务 ID 提取/轮询", () => {
    expect(parseScanSyncResult({ task_id: "t-1", status: "pending" }, IMAGE_B64)).toEqual({ urls: [] });
  });
});

describe("extractOpenAiTaskId", () => {
  it("poll 路径占位符字段优先（如 {video_id}）", () => {
    const cfg = { protocol: { endpoints: { "video.poll": "https://api.example.com/poll?video_id={video_id}" } } };
    expect(extractOpenAiTaskId({ video_id: "v-1", task_id: "t-1" }, cfg, "video")).toBe("v-1");
  });

  it("回退 task_id（含 data 嵌套）", () => {
    expect(extractOpenAiTaskId({ data: { task_id: "t-2" } }, undefined, "image")).toBe("t-2");
    expect(extractOpenAiTaskId({ data: [{ task_id: "t-3" }] }, undefined, "image")).toBe("t-3");
  });

  it("id 字段仅 pending 状态接受", () => {
    expect(extractOpenAiTaskId({ id: "id-1", status: "queued" }, undefined, "image")).toBe("id-1");
    expect(extractOpenAiTaskId({ id: "id-1", status: "succeeded" }, undefined, "image")).toBeNull();
  });
});
