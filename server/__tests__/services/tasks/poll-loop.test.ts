/**
 * 单次轮询核心测试（specs/task-queue-bullmq.md 规则 1）：
 * 永久性 4xx 透传响应体中的上游文案；408/425/429 与 5xx 不判死（pending 留给
 * 下一 tick）；2xx 交由协议层判定；响应体损坏与网络异常返回 error kind。
 * 轮询节奏、预算与终态写入已上移到 worker tick handler，不在本模块。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { fetchWithTimeout } = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }));

vi.mock("@server/core/http-client", () => ({ fetchWithTimeout }));
vi.mock("@server/core/logger", () => ({ logger: { warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@server/core/logger/utils", () => ({
  logEvent: vi.fn(),
  errText: (e: unknown) => String(e),
}));

import { pollUpstreamOnce } from "@server/services/tasks/poll-loop";
import type { PollOnceInput } from "@server/services/tasks/poll-loop";
import type { ProtocolService } from "@server/services/protocols/base";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const echoProtocol = {
  // 回显响应体为 PollResult（补齐契约要求的 urls 数组）
  parsePollResponse: (data: unknown) => ({ urls: [], ...(data as object) }),
} as unknown as ProtocolService;

function makeInput(overrides: Partial<PollOnceInput> = {}): PollOnceInput {
  return {
    taskId: "t-1",
    upstreamTaskId: "u-1",
    pollUrl: "https://api.example.com/tasks/u-1",
    headers: {},
    protocol: {} as ProtocolService,
    logChannel: "test",
    ...overrides,
  };
}

beforeEach(() => {
  fetchWithTimeout.mockReset();
});

describe("pollUpstreamOnce", () => {
  it("永久性 4xx 透传响应体中的上游文案", async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(400, { error: { message: "Your prompt was rejected by the content safety system." } })
    );
    await expect(pollUpstreamOnce(makeInput())).resolves.toEqual({
      kind: "failed",
      error: "Your prompt was rejected by the content safety system.（HTTP 400）",
    });
  });

  it("永久性 4xx 无可读文案时退化为状态码描述", async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse(404, {}));
    await expect(pollUpstreamOnce(makeInput())).resolves.toEqual({
      kind: "failed",
      error: "轮询失败（HTTP 404），upstream_task_id=u-1",
    });
  });

  it("408/425/429 与 5xx 不判死，返回 pending 留给下一 tick（瞬态口径）", async () => {
    for (const status of [408, 425, 429, 500, 502, 503]) {
      fetchWithTimeout.mockResolvedValue(jsonResponse(status, { error: "transient" }));
      await expect(pollUpstreamOnce(makeInput())).resolves.toEqual({ kind: "pending" });
    }
  });

  it("2xx 交由协议判定：completed 直接返回", async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(200, { status: "completed", urls: ["https://cdn.example.com/a.png"] })
    );
    await expect(pollUpstreamOnce(makeInput({ protocol: echoProtocol }))).resolves.toEqual({
      kind: "completed",
      urls: ["https://cdn.example.com/a.png"],
      text: undefined,
    });
  });

  it("2xx 交由协议判定：failed 透传上游文案", async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(200, { status: "failed", error: "upstream boom" })
    );
    await expect(pollUpstreamOnce(makeInput({ protocol: echoProtocol }))).resolves.toEqual({
      kind: "failed",
      error: "upstream boom",
    });
  });

  it("2xx 协议未注册解析器或缺省 → 默认 pending", async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse(200, { whatever: true }));
    await expect(pollUpstreamOnce(makeInput())).resolves.toEqual({ kind: "pending" });
  });

  it("2xx 响应体 JSON 解析失败 → error kind（当轮计异常，不判死）", async () => {
    fetchWithTimeout.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("unexpected end of body");
      },
      text: async () => "",
    });
    const outcome = await pollUpstreamOnce(makeInput());
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error).toContain("unexpected end of body");
  });

  it("网络异常（超时/连接失败）→ error kind", async () => {
    fetchWithTimeout.mockRejectedValue(new Error("connect ETIMEDOUT"));
    const outcome = await pollUpstreamOnce(makeInput());
    expect(outcome).toEqual({ kind: "error", error: "Error: connect ETIMEDOUT" });
  });

  it("signal 透传给 fetchWithTimeout（停机 drain 超时可中止在途轮询）", async () => {
    const controller = new AbortController();
    fetchWithTimeout.mockResolvedValue(jsonResponse(200, { status: "completed", urls: [] }));
    await pollUpstreamOnce(makeInput({ signal: controller.signal }));
    expect(fetchWithTimeout).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal, scene: "poll" })
    );
  });
});
