/**
 * LLM 能力服务回归测试。
 * 锁定同步执行骨架换接后的五条路径：
 * 成功 / 空文本判失败（A3 回归）/ HTTP 上游文案优先 / 超时分类 / 网络分类。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@server/services/protocols/base", () => ({
  getProtocol: vi.fn(),
}));
vi.mock("@server/services/request-builder/engine", () => ({
  build: vi.fn(() => ({})),
}));

import "@server/services/capabilities/llm/service";
import { getCapability } from "@server/services/capabilities/base";
import { getProtocol } from "@server/services/protocols/base";
import { GenerationFailureError } from "@server/services/tasks/failure";

const fakeProtocol = {
  name: "openai-test",
  buildLlmRequest: (baseUrl: string, _apiKey: string, body: unknown) => ({
    url: `${baseUrl}/chat/completions`,
    method: "POST",
    headers: {},
    body,
  }),
  parseLlmResponse: (data: unknown) => {
    const d = data as { text?: string };
    return { urls: [], text: d.text ?? "" };
  },
};

const ctx = {
  providerId: 1,
  baseUrl: "http://upstream.test",
  apiKey: "key",
  protocol: "openai-test",
  model: "test-model",
  userId: 1,
  taskId: "task-1",
  startedAt: null,
};

function stubFetch(handler: () => Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(handler));
}

beforeEach(() => {
  vi.mocked(getProtocol).mockReturnValue(fakeProtocol as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("LlmCapabilityService.generate", () => {
  it("成功路径：解析文本原样返回", async () => {
    stubFetch(async () => new Response(JSON.stringify({ text: "hello" }), { status: 200 }));
    const svc = getCapability("llm")!;
    const result = await svc.generate(ctx, { prompt: "hi" });
    expect(result).toEqual({ urls: [], text: "hello" });
  });

  it("空文本 → 判失败 upstream_no_result（A3 回归：此前静默 completed）", async () => {
    stubFetch(async () => new Response(JSON.stringify({ text: "" }), { status: 200 }));
    const svc = getCapability("llm")!;
    await expect(svc.generate(ctx, { prompt: "hi" })).rejects.toMatchObject({
      name: "GenerationFailureError",
      message: "Upstream returned empty content",
      errorCode: "generation.upstream_no_result",
    });
  });

  it("空文本但上游带失败文案 → 上游文案优先", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ text: "", error: { message: "content filter" } }), {
          status: 200,
        })
    );
    const svc = getCapability("llm")!;
    await expect(svc.generate(ctx, { prompt: "hi" })).rejects.toMatchObject({
      name: "GenerationFailureError",
      message: "content filter",
    });
  });

  it("HTTP 500 带上游文案 → GenerationFailureError(message)（不带码）", async () => {
    stubFetch(
      async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 })
    );
    const svc = getCapability("llm")!;
    await expect(svc.generate(ctx, { prompt: "hi" })).rejects.toBeInstanceOf(
      GenerationFailureError
    );
    await expect(svc.generate(ctx, { prompt: "hi" })).rejects.toMatchObject({
      message: "boom",
      errorCode: undefined,
    });
  });

  it("HTTP 502 空错误体 → 回退状态码 + upstream_http_error（此前缺失该分类）", async () => {
    stubFetch(async () => new Response("", { status: 502 }));
    const svc = getCapability("llm")!;
    await expect(svc.generate(ctx, { prompt: "hi" })).rejects.toMatchObject({
      message: "HTTP 502",
      errorCode: "generation.upstream_http_error",
    });
  });

  it("HTTP 502 纯文本体 → 文本即上游文案原样回传", async () => {
    stubFetch(async () => new Response("Bad Gateway", { status: 502 }));
    const svc = getCapability("llm")!;
    await expect(svc.generate(ctx, { prompt: "hi" })).rejects.toMatchObject({
      message: "Bad Gateway",
      errorCode: undefined,
    });
  });

  it("上游超时 → generation.timeout（此前缺失该分类）", async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    stubFetch(() => Promise.reject(err));
    const svc = getCapability("llm")!;
    await expect(svc.generate(ctx, { prompt: "hi" })).rejects.toMatchObject({
      message: "API call timed out",
      errorCode: "generation.timeout",
    });
  });

  it("网络异常 → generation.network_error（此前缺失该分类）", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const svc = getCapability("llm")!;
    await expect(svc.generate(ctx, { prompt: "hi" })).rejects.toMatchObject({
      errorCode: "generation.network_error",
    });
  });
});
