/**
 * 任务管理器回归测试。
 * 锁定 submitAndWait 全分支：同步完成 / 提交失败 / HTTP 错误提取 task_id 升级轮询 /
 * 提交后已取消 / 无结果无 task_id / 守卫拒绝 / 落盘推迟续轮询 / 不支持轮询 / signal 贯穿。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchUpstream: vi.fn(),
  httpUpstreamFailure: vi.fn(),
  noUpstreamResult: vi.fn(),
  getConfig: vi.fn(),
  logEvent: vi.fn(),
  errText: vi.fn((e: unknown) => String(e)),
  markTaskProcessing: vi.fn(),
  isTaskCancelled: vi.fn(),
  touchTaskHeartbeat: vi.fn(),
  pollUpstreamTask: vi.fn(),
}));

vi.mock("@server/services/tasks/sync-fetch", () => ({
  fetchUpstream: mocks.fetchUpstream,
  httpUpstreamFailure: mocks.httpUpstreamFailure,
  noUpstreamResult: mocks.noUpstreamResult,
}));
vi.mock("@server/core/config", () => ({ getConfig: mocks.getConfig }));
vi.mock("@server/core/logger/utils", () => ({
  logEvent: mocks.logEvent,
  errText: mocks.errText,
}));
vi.mock("@server/crud/task", () => ({
  markTaskProcessing: mocks.markTaskProcessing,
  isTaskCancelled: mocks.isTaskCancelled,
  touchTaskHeartbeat: mocks.touchTaskHeartbeat,
}));
vi.mock("@server/services/tasks/poll-loop", () => ({
  pollUpstreamTask: mocks.pollUpstreamTask,
}));

import { submitAndWait } from "./manager";

const protocol = {
  name: "test",
  extractTaskId: vi.fn(),
  buildPollUrl: vi.fn(() => "http://upstream.test/poll/up-1"),
};

const STARTED_AT = new Date("2026-01-01T00:00:00.000Z");

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-1",
    userId: 1,
    startedAt: STARTED_AT,
    protocol,
    capability: "image",
    baseUrl: "http://upstream.test",
    apiKey: "key",
    body: { model: "m" },
    buildRequest: () => ({
      url: "http://upstream.test/v1/x",
      method: "POST",
      headers: {},
      body: { model: "m" },
    }),
    parseResponse: () => ({ urls: [] }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConfig.mockReturnValue({
    WORKER_ASYNC_POLL_INTERVAL: 1,
    WORKER_ASYNC_POLL_MAX_ATTEMPTS: 3,
    WORKER_ASYNC_POLL_INITIAL_DELAY: 0,
  });
  mocks.isTaskCancelled.mockResolvedValue(false);
  mocks.markTaskProcessing.mockResolvedValue(true);
  mocks.pollUpstreamTask.mockResolvedValue({ kind: "completed", urls: ["u"], text: "t" });
  protocol.extractTaskId.mockReturnValue(undefined);
});

describe("submitAndWait", () => {
  it("同步响应含结果 → completed，不进入轮询", async () => {
    mocks.fetchUpstream.mockResolvedValue({ kind: "data", data: { url: "u" } });

    const result = await submitAndWait(makeInput({
      parseResponse: () => ({ urls: ["u1"] }),
    }));

    expect(result).toMatchObject({ status: "completed", urls: ["u1"] });
    expect(mocks.pollUpstreamTask).not.toHaveBeenCalled();
  });

  it("提交失败（超时/网络）→ 原样透传错误与分类，不再提交", async () => {
    mocks.fetchUpstream.mockResolvedValue({
      kind: "failure",
      error: "API call timed out",
      errorCode: "generation.timeout",
    });

    const result = await submitAndWait(makeInput());

    expect(result).toEqual({
      status: "failed",
      urls: [],
      error: "API call timed out",
      errorCode: "generation.timeout",
    });
    expect(mocks.pollUpstreamTask).not.toHaveBeenCalled();
  });

  it("HTTP 错误体中携带 task_id → 视为上游已受理，升级为轮询", async () => {
    mocks.fetchUpstream.mockResolvedValue({
      kind: "http-error",
      status: 500,
      errText: "{}",
      errData: { task_id: "up-1" },
    });
    protocol.extractTaskId.mockReturnValue("up-1");

    const result = await submitAndWait(makeInput());

    expect(result).toMatchObject({ status: "completed", urls: ["u"] });
    const pollInput = mocks.pollUpstreamTask.mock.calls[0][0];
    expect(pollInput).toMatchObject({ taskId: "task-1", upstreamTaskId: "up-1" });
    expect(mocks.markTaskProcessing).toHaveBeenCalledWith("task-1", "up-1", STARTED_AT);
  });

  it("提取到 task_id 时任务已被取消 → cancelled，不轮询", async () => {
    mocks.fetchUpstream.mockResolvedValue({
      kind: "data",
      data: { task_id: "up-1" },
    });
    protocol.extractTaskId.mockReturnValue("up-1");
    mocks.isTaskCancelled.mockResolvedValue(true);

    const result = await submitAndWait(makeInput());

    expect(result).toEqual({ status: "cancelled", urls: [] });
    expect(mocks.pollUpstreamTask).not.toHaveBeenCalled();
  });

  it("HTTP 错误体无 task_id → 经 httpUpstreamFailure 翻译后失败", async () => {
    mocks.fetchUpstream.mockResolvedValue({
      kind: "http-error",
      status: 500,
      errText: "boom",
      errData: { error: { message: "boom" } },
    });
    mocks.httpUpstreamFailure.mockReturnValue({ error: "boom" });

    const result = await submitAndWait(makeInput());

    expect(result).toEqual({ status: "failed", urls: [], error: "boom" });
    // 原始错误体只进日志，不进对外 error
    expect(mocks.logEvent).toHaveBeenCalledWith(
      "taskmgr",
      expect.objectContaining({ stage: "upstream_http_error", body: "boom" })
    );
  });

  it("无结果无 task_id → 失败兜底文案；raw_sample 只进日志与 metadata", async () => {
    const data = { weird: "payload", secret: "SECRET_VALUE" };
    mocks.fetchUpstream.mockResolvedValue({ kind: "data", data });
    mocks.noUpstreamResult.mockReturnValue({
      error: "Upstream returned neither result nor task_id",
      errorCode: "generation.upstream_no_result",
    });

    const result = await submitAndWait(makeInput());

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Upstream returned neither result nor task_id");
    expect(result.errorCode).toBe("generation.upstream_no_result");
    // 完整响应体不进对外 error，只进日志与 metadata
    expect(result.error).not.toContain("SECRET_VALUE");
    expect(result.metadata).toEqual({ raw_sample: expect.stringContaining("SECRET_VALUE") });
    expect(mocks.logEvent).toHaveBeenCalledWith(
      "taskmgr",
      expect.objectContaining({ stage: "upstream_no_result" })
    );
  });

  it("处理态落盘被守卫拒绝 → ownership lost，不继续轮询", async () => {
    mocks.fetchUpstream.mockResolvedValue({ kind: "data", data: { task_id: "up-1" } });
    protocol.extractTaskId.mockReturnValue("up-1");
    mocks.markTaskProcessing.mockResolvedValue(false);

    const result = await submitAndWait(makeInput());

    expect(result).toEqual({ status: "failed", urls: [], error: "Task ownership lost" });
    expect(mocks.pollUpstreamTask).not.toHaveBeenCalled();
  });

  it("处理态落盘持续失败 → 推迟落盘但继续轮询（上游已受理不判死）", async () => {
    mocks.fetchUpstream.mockResolvedValue({ kind: "data", data: { task_id: "up-1" } });
    protocol.extractTaskId.mockReturnValue("up-1");
    mocks.markTaskProcessing.mockRejectedValue(new Error("db down"));

    const result = await submitAndWait(makeInput());

    expect(mocks.markTaskProcessing).toHaveBeenCalledTimes(3);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      "taskmgr",
      expect.objectContaining({ stage: "processing_persist_deferred" })
    );
    expect(result).toMatchObject({ status: "completed", urls: ["u"] });
  });

  it("协议不支持轮询 → 直接失败，避免无限 pending", async () => {
    mocks.fetchUpstream.mockResolvedValue({ kind: "data", data: { task_id: "up-1" } });
    const noPollProtocol = { name: "bare", extractTaskId: vi.fn(() => "up-1") };

    const result = await submitAndWait(makeInput({ protocol: noPollProtocol }));

    expect(result).toEqual({
      status: "failed",
      urls: [],
      error: expect.stringContaining("does not support polling"),
    });
  });

  it("轮询超时 outcome 原样透传，错误文案不含完整响应体（R3）", async () => {
    mocks.fetchUpstream.mockResolvedValue({ kind: "data", data: { task_id: "up-1" } });
    protocol.extractTaskId.mockReturnValue("up-1");
    mocks.pollUpstreamTask.mockResolvedValue({
      kind: "failed",
      error: "异步轮询超时（upstream_task_id=up-1）",
      errorCode: "generation.poll_timeout",
    });

    const result = await submitAndWait(makeInput());

    expect(result).toEqual({
      status: "failed",
      urls: [],
      error: "异步轮询超时（upstream_task_id=up-1）",
      errorCode: "generation.poll_timeout",
    });
    expect(result.error).not.toContain("{");
  });

  it("signal 贯穿提交请求与轮询", async () => {
    const controller = new AbortController();
    mocks.fetchUpstream.mockResolvedValue({ kind: "data", data: { task_id: "up-1" } });
    protocol.extractTaskId.mockReturnValue("up-1");

    await submitAndWait(makeInput({ signal: controller.signal }));

    expect(mocks.fetchUpstream).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://upstream.test/v1/x" }),
      "task-1",
      "taskmgr",
      controller.signal
    );

    // 轮询侧经 shouldStop 闭包消费 signal：abort 后 shouldStop 立即为真
    const pollInput = mocks.pollUpstreamTask.mock.calls[0][0] as {
      shouldStop: () => Promise<boolean>;
    };
    controller.abort();
    await expect(pollInput.shouldStop()).resolves.toBe(true);
  });
});
