/**
 * 上游失败信号统一解释层测试：状态词归一化、失败证据扫描、可读文案提取，
 * 以及上游文案优先原样回传（不附错误码）的翻译规则。
 */
import { describe, expect, it } from "vitest";

import {
  extractUpstreamMessage,
  failFromUpstream,
  normalizeStatus,
  scanErrorEvidence,
  scanFailureStatus,
} from "./failure";

describe("normalizeStatus", () => {
  it("pending 类 / completed 类 / failed 类归一化，未知值原样返回", () => {
    expect(normalizeStatus("Running")).toBe("pending");
    expect(normalizeStatus(" succeeded ")).toBe("completed");
    expect(normalizeStatus("CANCELLED")).toBe("failed");
    expect(normalizeStatus("75%")).toBe("75%");
  });
});

describe("scanErrorEvidence", () => {
  it("任意层级的 error / errors / detail 键携带非空内容即证据", () => {
    expect(scanErrorEvidence({ error: { message: "content safety" } })).toBe("content safety");
    expect(scanErrorEvidence({ data: { detail: "insufficient credits" } })).toBe("insufficient credits");
    expect(scanErrorEvidence({ errors: [{ message: "first" }, { message: "second" }] })).toBe("first");
    expect(scanErrorEvidence({ error: "boom" })).toBe("boom");
  });

  it("message / msg 是进度字段不算证据，空值不算证据", () => {
    expect(scanErrorEvidence({ message: "processing" })).toBeNull();
    expect(scanErrorEvidence({ msg: "queued" })).toBeNull();
    expect(scanErrorEvidence({ error: null })).toBeNull();
    expect(scanErrorEvidence({ error: "" })).toBeNull();
    expect(scanErrorEvidence({ detail: [] })).toBeNull();
    expect(scanErrorEvidence({ error: { message: "" } })).toBeNull();
  });

  it("prompt 回显不参与证据判定", () => {
    expect(scanErrorEvidence({ prompts: [{ error: "echo" }] })).toBeNull();
    expect(scanErrorEvidence({ prompt: "write about an error" })).toBeNull();
  });
});

describe("scanFailureStatus", () => {
  it("任意字段值精确命中失败状态词（顶层 status 只是特例）", () => {
    expect(scanFailureStatus({ status: "failed" })).toBe("failed");
    expect(scanFailureStatus({ data: { state: "Cancelled" } })).toBe("cancelled");
    expect(scanFailureStatus({ result: "ERROR" })).toBe("error");
  });

  it("非精确命中与 pending / completed 词不算失败", () => {
    expect(scanFailureStatus({ status: "processing" })).toBeNull();
    expect(scanFailureStatus({ status: "succeeded" })).toBeNull();
    expect(scanFailureStatus({ message: "task failed to start, retrying" })).toBeNull();
    expect(scanFailureStatus({ model: "error-detection-model" })).toBeNull();
    expect(scanFailureStatus({ prompt: "failed" })).toBeNull();
  });
});

describe("extractUpstreamMessage", () => {
  it("错误证据优先，其次顶层 msg / message", () => {
    expect(extractUpstreamMessage({ error: { message: "boom" } })).toBe("boom");
    expect(extractUpstreamMessage({ data: { detail: "deep" } })).toBe("deep");
    expect(extractUpstreamMessage({ error: "err", message: "ignored" })).toBe("err");
    expect(extractUpstreamMessage({ msg: "top msg" })).toBe("top msg");
    expect(extractUpstreamMessage({ message: "top message" })).toBe("top message");
  });

  it("字符串体先 JSON 解析，非 JSON 原样截断 200", () => {
    expect(extractUpstreamMessage('{"error":"parsed"}')).toBe("parsed");
    expect(extractUpstreamMessage("<html>gateway error</html>".repeat(20))).toHaveLength(200);
  });

  it("JSON 标量字符串体即文案；null / 数字无信号", () => {
    expect(extractUpstreamMessage('"oops"')).toBe("oops");
    expect(extractUpstreamMessage("null")).toBe("");
    expect(extractUpstreamMessage("123")).toBe("");
  });

  it("文案限长 200", () => {
    expect(extractUpstreamMessage({ error: "x".repeat(500) })).toHaveLength(200);
  });

  it("无任何信号返回空串", () => {
    expect(extractUpstreamMessage({})).toBe("");
    expect(extractUpstreamMessage({ status: "processing", progress: 50 })).toBe("");
  });
});

describe("failFromUpstream", () => {
  it("上游有可读文案时原样回传且不带错误码", () => {
    expect(failFromUpstream("content policy violation", { message: "HTTP 400", code: "generation.upstream_http_error" }))
      .toEqual({ error: "content policy violation" });
  });

  it("上游无文案时回退兜底文案与错误码", () => {
    expect(failFromUpstream("", { message: "HTTP 502", code: "generation.upstream_http_error" }))
      .toEqual({ error: "HTTP 502", errorCode: "generation.upstream_http_error" });
  });
});
