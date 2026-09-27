/**
 * 同步执行段回归测试。
 * 锁定：2xx/非 2xx/超时/网络四分支、错误体读取、
 * HTTP 翻译与空结果判失败的上游文案优先规则。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchUpstream,
  httpUpstreamFailure,
  noUpstreamResult,
} from "@server/services/tasks/sync-fetch";

const req = {
  url: "http://upstream.test/v1/x",
  method: "POST",
  headers: {},
  body: { model: "m" },
};

function stubFetch(handler: () => Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(handler));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchUpstream", () => {
  it("2xx JSON → data", async () => {
    stubFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const outcome = await fetchUpstream(req, "t1");
    expect(outcome).toEqual({ kind: "data", data: { ok: true } });
  });

  it("2xx 响应体非 JSON → 按网络失败分类（对齐旧 submitAndWait 行为）", async () => {
    stubFetch(async () => new Response("not json at all", { status: 200 }));
    const outcome = await fetchUpstream(req, "t1");
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.errorCode).toBe("generation.network_error");
    }
  });

  it("非 2xx JSON 错误体 → http-error 携带原始文本与解析结果", async () => {
    const body = JSON.stringify({ error: { message: "boom" } });
    stubFetch(async () => new Response(body, { status: 500 }));
    const outcome = await fetchUpstream(req, "t1");
    expect(outcome).toEqual({
      kind: "http-error",
      status: 500,
      errText: body,
      errData: { error: { message: "boom" } },
    });
  });

  it("非 2xx 纯文本错误体（网关 HTML 页）→ errData 为空对象", async () => {
    stubFetch(async () => new Response("<html>Bad Gateway</html>", { status: 502 }));
    const outcome = await fetchUpstream(req, "t1");
    expect(outcome.kind).toBe("http-error");
    if (outcome.kind === "http-error") {
      expect(outcome.status).toBe(502);
      expect(outcome.errData).toEqual({});
      expect(outcome.errText).toContain("Bad Gateway");
    }
  });

  it("TimeoutError → generation.timeout", async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    stubFetch(() => Promise.reject(err));
    const outcome = await fetchUpstream(req, "t1");
    expect(outcome).toEqual({
      kind: "failure",
      error: "API call timed out",
      errorCode: "generation.timeout",
    });
  });

  it("其余异常 → generation.network_error，cause 细节拼进文案", async () => {
    const err = new TypeError("fetch failed");
    (err as Error & { cause?: unknown }).cause = { code: "ECONNREFUSED" };
    stubFetch(() => Promise.reject(err));
    const outcome = await fetchUpstream(req, "t1");
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.error).toContain("fetch failed");
      expect(outcome.error).toContain("ECONNREFUSED");
      expect(outcome.errorCode).toBe("generation.network_error");
    }
  });
});

describe("httpUpstreamFailure", () => {
  it("上游自带可读文案 → 原样回传不带码", () => {
    expect(httpUpstreamFailure(500, '{"error":{"message":"boom"}}')).toEqual({ error: "boom" });
  });

  it("纯文本错误体 → 文本即上游文案，原样回传", () => {
    expect(httpUpstreamFailure(502, "Bad Gateway")).toEqual({ error: "Bad Gateway" });
  });

  it("空错误体 → 回退状态码文案 + 错误码", () => {
    expect(httpUpstreamFailure(502, "")).toEqual({
      error: "HTTP 502",
      errorCode: "generation.upstream_http_error",
    });
  });
});

describe("noUpstreamResult", () => {
  it("上游数据无失败信号 → 回退调用方场景文案 + 错误码", () => {
    expect(noUpstreamResult({ foo: 1 }, "Upstream returned empty content")).toEqual({
      error: "Upstream returned empty content",
      errorCode: "generation.upstream_no_result",
    });
  });

  it("上游数据自带失败文案 → 原样回传不带码", () => {
    expect(noUpstreamResult({ error: { message: "quota exceeded" } }, "fallback")).toEqual({
      error: "quota exceeded",
    });
  });
});
