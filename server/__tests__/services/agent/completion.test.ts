/**
 * Agent 上游调用层回归测试（R2：T16 验收遗留项）。
 * 锁定：工具注入按 ProtocolCapabilities 标志分支（而非协议名）、
 * 无 LLM 协议（ark 形态）报结构化错误码、provider 缺失报 agent.provider_not_found、
 * 消息形状回填（tool / assistant.tool_calls / 参考图分支）、
 * 流式文本与 tool_calls 分片（按 index）累积、B4 透传不再二次查库。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  getProviders: vi.fn(),
  fetchWithTimeout: vi.fn(),
  getProtocol: vi.fn(),
}));

vi.mock("@server/crud/model-config", () => ({
  getProvider: mocks.getProvider,
  getProviders: mocks.getProviders,
}));
vi.mock("@server/core/http-client", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
  getWorkerApiTimeout: () => 1000,
}));
vi.mock("@server/services/resolvers/reference", () => ({
  resolveRefImages: async (images: string[]) => images,
}));
vi.mock("@server/services/protocols/base", () => ({
  getProtocol: mocks.getProtocol,
}));

import { buildUpstream, resolveProvider, runCompletionStream } from "@server/services/agent/completion";
import { agentToolRegistry } from "@server/services/agent/tools/registry";
import "@server/services/agent/tools/definitions"; // 触发工具注册（与 completion.ts 的副作用导入保持一致）

const provider = {
  id: 1,
  userId: 1,
  name: "prov-1",
  baseUrl: "http://upstream.test",
  apiKey: "sk-test",
  protocol: "openai",
  models: [{ name: "m-1" }],
};

/** openai 形态：有 buildLlmRequest，能力全开 */
const openaiProtocol = {
  name: "openai",
  capabilities: { supportsTools: true, supportsImageParts: true },
  buildLlmRequest: (baseUrl: string, _apiKey: string, body: unknown) => ({
    url: `${baseUrl}/chat/completions`,
    method: "POST",
    headers: { authorization: "Bearer x" },
    body,
  }),
};

/** 有 buildLlmRequest 但能力全关（声明式能力判定的关键对照：协议名不参与判定） */
const noCapProtocol = {
  name: "openai-like",
  capabilities: {},
  buildLlmRequest: openaiProtocol.buildLlmRequest,
};

/** 无 buildLlmRequest（ark 真实形态） */
const noLlmProtocol = { name: "ark", capabilities: {} };

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(new TextEncoder().encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const dataFrame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

describe("resolveProvider", () => {
  it("providerId 优先精确查找（并传 userId 做所有权校验）", async () => {
    mocks.getProvider.mockResolvedValueOnce(provider);
    const got = await resolveProvider(1, 7, "m-1");
    expect(got).toBe(provider);
    expect(mocks.getProvider).toHaveBeenCalledWith(7, 1);
    expect(mocks.getProviders).not.toHaveBeenCalled();
  });

  it("无 providerId 时按 model 名称匹配", async () => {
    const other = { ...provider, id: 2, models: [{ name: "other" }] };
    mocks.getProviders.mockResolvedValueOnce([other, provider]);
    const got = await resolveProvider(1, undefined, "m-1");
    expect(got).toBe(provider);
  });

  it("无匹配回退第一个，无任何供应商返回 null", async () => {
    mocks.getProviders.mockResolvedValueOnce([provider]);
    expect(await resolveProvider(1, undefined, "unknown-model")).toBe(provider);

    mocks.getProviders.mockResolvedValueOnce([]);
    expect(await resolveProvider(1)).toBeNull();
  });
});

describe("buildUpstream", () => {
  beforeEach(() => {
    mocks.getProviders.mockResolvedValue([provider]);
    mocks.getProvider.mockResolvedValue(provider);
  });

  it("agent + supportsTools → 注入注册表工具与调用约束", async () => {
    mocks.getProtocol.mockReturnValue(openaiProtocol);
    const result = await buildUpstream({
      messages: [{ role: "user", content: "hi" }],
      userId: 1,
      model: "m-1",
      agent: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.body as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.model).toBe("m-1");
    expect(body.tools).toEqual(agentToolRegistry.getOpenAiTools());
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(false);
  });

  it("agent 但协议能力全关（ark 形态协议名+buildLlmRequest 俱全）→ 不注入工具", async () => {
    mocks.getProtocol.mockReturnValue(noCapProtocol);
    const result = await buildUpstream({
      messages: [{ role: "user", content: "hi" }],
      userId: 1,
      agent: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.body as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.stream).toBe(true);
  });

  it("非 agent 请求即使能力全开也不注入工具", async () => {
    mocks.getProtocol.mockReturnValue(openaiProtocol);
    const result = await buildUpstream({
      messages: [{ role: "user", content: "hi" }],
      userId: 1,
      agent: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.body as Record<string, unknown>).tools).toBeUndefined();
  });

  it("无可用 provider → agent.provider_not_found", async () => {
    mocks.getProviders.mockResolvedValue([]);
    mocks.getProtocol.mockReturnValue(openaiProtocol);
    const result = await buildUpstream({ messages: [{ role: "user", content: "hi" }], userId: 1 });
    expect(result).toMatchObject({ ok: false, error: "no available provider", errorCode: "agent.provider_not_found" });
  });

  it("协议无 buildLlmRequest（ark）→ agent.upstream_failed 结构化错误", async () => {
    mocks.getProviders.mockResolvedValue([{ ...provider, protocol: "ark" }]);
    mocks.getProtocol.mockReturnValue(noLlmProtocol);
    const result = await buildUpstream({ messages: [{ role: "user", content: "hi" }], userId: 1 });
    expect(result).toMatchObject({ ok: false, errorCode: "agent.upstream_failed" });
    if (result.ok) return;
    expect(result.error).toContain("ark");
  });

  it("tool 消息映射 tool_call_id；assistant.toolCalls 回填 tool_calls 形状", async () => {
    mocks.getProtocol.mockReturnValue(openaiProtocol);
    const result = await buildUpstream({
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "create_node", args: { kind: "text" } }] },
        { role: "tool", toolCallId: "call_1", content: "done" },
      ],
      userId: 1,
      agent: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const messages = (result.body as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "create_node", arguments: '{"kind":"text"}' } }],
    });
    expect(messages[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "done" });
  });

  it("参考图：supportsImageParts 时拆多模态 content 数组", async () => {
    mocks.getProtocol.mockReturnValue(openaiProtocol);
    const result = await buildUpstream({
      messages: [{ role: "user", content: "看图", images: ["http://a/1.png"] }],
      userId: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const messages = (result.body as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    expect(messages[0].content).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "http://a/1.png" } },
    ]);
  });

  it("参考图：不支持 imageParts 时保持纯文本（URL 不进 content）", async () => {
    mocks.getProtocol.mockReturnValue(noCapProtocol);
    const result = await buildUpstream({
      messages: [{ role: "user", content: "看图", images: ["http://a/1.png"] }],
      userId: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const messages = (result.body as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    expect(messages[0].content).toBe("看图");
  });
});

describe("runCompletionStream", () => {
  beforeEach(() => {
    mocks.getProviders.mockResolvedValue([provider]);
    mocks.getProvider.mockResolvedValue(provider);
    mocks.getProtocol.mockReturnValue(openaiProtocol);
  });

  it("SSE 文本增量累积 + onDelta 逐片推送", async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      sseResponse([
        dataFrame({ choices: [{ delta: { content: "he" } }] }),
        dataFrame({ choices: [{ delta: { content: "llo" } }] }),
        "data: [DONE]\n\n",
      ])
    );
    const deltas: string[] = [];
    const result = await runCompletionStream({
      messages: [{ role: "user", content: "hi" }],
      userId: 1,
      onDelta: (d) => deltas.push(d),
    });
    expect(result).toMatchObject({ ok: true, text: "hello" });
    expect(deltas).toEqual(["he", "llo"]);
  });

  it("tool_calls 分片按 index 累积：args 字符串拼接后解析，无 id 补生成", async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      sseResponse([
        dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "create_node", arguments: '{"kind"' } }] } }] }),
        dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"text"}' } }] } }] }),
        dataFrame({ choices: [{ delta: { content: "x" } }] }),
        "data: [DONE]\n\n",
      ])
    );
    const result = await runCompletionStream({
      messages: [{ role: "user", content: "hi" }],
      userId: 1,
      agent: true,
      onDelta: () => {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("x");
    expect(result.toolCalls).toEqual([
      { id: "call_9", name: "create_node", args: { kind: "text" } },
    ]);
  });

  it("坏 JSON args 解析失败降级为空对象，不炸流", async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      sseResponse([
        dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "t", arguments: "{oops" } }] } }] }),
        "data: [DONE]\n\n",
      ])
    );
    const result = await runCompletionStream({
      messages: [{ role: "user", content: "hi" }],
      userId: 1,
      agent: true,
      onDelta: () => {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolCalls).toEqual([{ id: "c", name: "t", args: {} }]);
  });

  it("非 agent 时 tool_call 分片不进结果", async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      sseResponse([
        dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "t", arguments: "{}" } }] } }] }),
        "data: [DONE]\n\n",
      ])
    );
    const result = await runCompletionStream({
      messages: [{ role: "user", content: "hi" }],
      userId: 1,
      agent: false,
      onDelta: () => {},
    });
    expect(result).toMatchObject({ ok: true, text: "" });
    expect((result as { toolCalls?: unknown }).toolCalls).toBeUndefined();
  });

  it("上游非 2xx → agent.upstream_failed 且透出上游文案", async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      new Response("boom, quota exceeded", { status: 500 })
    );
    const result = await runCompletionStream({
      messages: [{ role: "user", content: "hi" }],
      userId: 1,
      onDelta: () => {},
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "agent.upstream_failed",
    });
    if (result.ok) return;
    expect(result.error).toContain("upstream 500");
    expect(result.error).toContain("quota exceeded");
  });

  it("fetch 抛错（网络/超时）→ agent.upstream_failed", async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("timeout"));
    const result = await runCompletionStream({
      messages: [{ role: "user", content: "hi" }],
      userId: 1,
      onDelta: () => {},
    });
    expect(result).toMatchObject({ ok: false, errorCode: "agent.upstream_failed" });
  });

  it("build 失败不发起 fetch 且透传错误码", async () => {
    mocks.getProviders.mockResolvedValue([]);
    const result = await runCompletionStream({
      messages: [{ role: "user", content: "hi" }],
      userId: 1,
      onDelta: () => {},
    });
    expect(result).toMatchObject({ ok: false, errorCode: "agent.provider_not_found" });
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("B4：provider 信息由 buildUpstream 透传，全程只查一次库", async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      sseResponse([dataFrame({ choices: [{ delta: { content: "ok" } }] }), "data: [DONE]\n\n"])
    );
    const result = await runCompletionStream({
      messages: [{ role: "user", content: "hi" }],
      userId: 1,
      onDelta: () => {},
    });
    expect(result.ok).toBe(true);
    expect(mocks.getProviders).toHaveBeenCalledTimes(1);
    expect(mocks.getProvider).not.toHaveBeenCalled();
  });

  it("buildUpstream 结果携带 providerName（日志/展示用）", async () => {
    mocks.getProtocol.mockReturnValue(openaiProtocol);
    const result = await buildUpstream({ messages: [{ role: "user", content: "hi" }], userId: 1 });
    expect(result).toMatchObject({ ok: true, providerName: "prov-1" });
  });
});

afterEach(() => {
  vi.mocked(mocks.getProtocol).mockReset();
  vi.clearAllMocks();
});
