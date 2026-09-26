/**
 * 上游轮询核心测试：永久性 4xx 透传响应体中的上游文案、
 * 5xx 不判死（耗尽次数按超时失败）、2xx 交由协议层判定。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { fetchWithTimeout } = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }));

vi.mock("@server/core/http-client", () => ({ fetchWithTimeout }));
vi.mock("@server/core/logger", () => ({ logger: { warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@server/core/logger/utils", () => ({
  logEvent: vi.fn(),
  errText: (e: unknown) => String(e),
}));
vi.mock("@server/crud/task", () => ({ TASK_HEARTBEAT_INTERVAL_MS: 30_000 }));

import { pollUpstreamTask } from "./poll-loop";
import type { PollLoopInput } from "./poll-loop";
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

function makeInput(overrides: Partial<PollLoopInput> = {}): PollLoopInput {
  return {
    taskId: "t-1",
    upstreamTaskId: "u-1",
    pollUrl: "https://api.example.com/tasks/u-1",
    headers: {},
    protocol: {} as ProtocolService,
    pollInterval: 0,
    maxPollAttempts: 2,
    initialDelay: 0,
    onHeartbeat: async () => true,
    shouldStop: async () => false,
    logChannel: "test",
    ...overrides,
  };
}

beforeEach(() => {
  fetchWithTimeout.mockReset();
});

describe("pollUpstreamTask", () => {
  it("永久性 4xx 透传响应体中的上游文案", async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(400, { error: { message: "Your prompt was rejected by the content safety system." } })
    );
    await expect(pollUpstreamTask(makeInput())).resolves.toEqual({
      kind: "failed",
      error: "Your prompt was rejected by the content safety system.（HTTP 400）",
    });
  });

  it("永久性 4xx 无可读文案时退化为状态码描述", async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse(404, {}));
    await expect(pollUpstreamTask(makeInput())).resolves.toEqual({
      kind: "failed",
      error: "轮询失败（HTTP 404），upstream_task_id=u-1",
    });
  });

  it("5xx 不判死，耗尽次数后按超时失败", async () => {
    fetchWithTimeout.mockResolvedValue(jsonResponse(502, { error: "bad gateway" }));
    const outcome = await pollUpstreamTask(makeInput());
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      kind: "failed",
      error: "异步轮询超时（upstream_task_id=u-1）",
      errorCode: "generation.poll_timeout",
    });
  });

  it("2xx 交由协议判定：completed 直接返回", async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(200, { status: "completed", urls: ["https://cdn.example.com/a.png"] })
    );
    await expect(pollUpstreamTask(makeInput({ protocol: echoProtocol }))).resolves.toEqual({
      kind: "completed",
      urls: ["https://cdn.example.com/a.png"],
      text: undefined,
    });
  });

  it("2xx 交由协议判定：failed 透传上游文案", async () => {
    fetchWithTimeout.mockResolvedValue(
      jsonResponse(200, { status: "failed", error: "upstream boom" })
    );
    await expect(pollUpstreamTask(makeInput({ protocol: echoProtocol }))).resolves.toEqual({
      kind: "failed",
      error: "upstream boom",
    });
  });
});
