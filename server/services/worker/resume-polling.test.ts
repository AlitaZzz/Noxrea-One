/**
 * 异步任务恢复轮询回归测试。
 * 锁定：终态编排分派（completed → finalize / failed → 透传 / exhausted → 重入队
 * 或烧完落终态 / stopped → 不写）、解析失败的兜底失败、停机与取消进入 shouldStop。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getProvider: vi.fn(),
  getProtocol: vi.fn(),
  resolveProviderEndpoints: vi.fn(),
  safeFailTask: vi.fn(),
  isTaskCancelled: vi.fn(),
  touchTaskHeartbeat: vi.fn(),
  requeueProcessingAsyncTask: vi.fn(),
  pollUpstreamTask: vi.fn(),
  finalizeGeneratedResult: vi.fn(),
  logEvent: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@server/core/config", () => ({ getConfig: mocks.getConfig }));
vi.mock("@server/crud/model-config", () => ({ getProvider: mocks.getProvider }));
vi.mock("@server/services/protocols/base", () => ({ getProtocol: mocks.getProtocol }));
vi.mock("@server/services/model-config", () => ({
  resolveProviderEndpoints: mocks.resolveProviderEndpoints,
  hostFromBaseUrl: vi.fn(() => "upstream.test"),
}));
vi.mock("@server/crud/task", () => ({
  safeFailTask: mocks.safeFailTask,
  isTaskCancelled: mocks.isTaskCancelled,
  touchTaskHeartbeat: mocks.touchTaskHeartbeat,
  requeueProcessingAsyncTask: mocks.requeueProcessingAsyncTask,
}));
vi.mock("@server/services/tasks/poll-loop", () => ({ pollUpstreamTask: mocks.pollUpstreamTask }));
vi.mock("./download-results", () => ({ finalizeGeneratedResult: mocks.finalizeGeneratedResult }));
vi.mock("@server/core/logger/utils", () => ({ logEvent: mocks.logEvent, errText: (e: unknown) => String(e) }));
vi.mock("@server/core/logger", () => ({ logger: { error: mocks.loggerError } }));

import { resumeAsyncPolling } from "./resume-polling";
import type { StopSignal } from "./loop";
import type { HydratedGenerationTask } from "@server/crud/task";

const STARTED_AT = new Date("2026-01-01T00:00:00.000Z");

function makeStopSignal(): StopSignal {
  const controller = new AbortController();
  return { stopped: false, signal: controller.signal, abort: () => controller.abort() };
}

function makeTask(): HydratedGenerationTask {
  return {
    id: "task-1",
    userId: 1,
    type: "image",
    protocol: "openai",
    model: "m-1",
    config: { providerId: 7 },
    upstreamTaskId: "up-1",
    startedAt: STARTED_AT,
  } as unknown as HydratedGenerationTask;
}

const protocol = {
  name: "test",
  buildPollUrl: vi.fn(() => "http://upstream.test/poll/up-1"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConfig.mockReturnValue({
    WORKER_ASYNC_POLL_MAX_ATTEMPTS: 3,
    WORKER_ASYNC_POLL_INTERVAL: 1,
    WORKER_MAX_RETRIES: 2,
  });
  mocks.getProvider.mockResolvedValue({ baseUrl: "http://upstream.test/", apiKey: "key", protocol: "openai" });
  mocks.getProtocol.mockReturnValue(protocol);
  mocks.resolveProviderEndpoints.mockReturnValue(undefined);
  mocks.isTaskCancelled.mockResolvedValue(false);
  mocks.touchTaskHeartbeat.mockResolvedValue(true);
  mocks.safeFailTask.mockResolvedValue({ id: "task-1" });
  mocks.finalizeGeneratedResult.mockResolvedValue(undefined);
  mocks.pollUpstreamTask.mockResolvedValue({ kind: "lost" });
});

describe("resumeAsyncPolling", () => {
  it("轮询完成 → finalizeGeneratedResult 编排下载落盘与 safe 终态", async () => {
    mocks.pollUpstreamTask.mockResolvedValue({ kind: "completed", urls: ["u1"], text: "t" });

    await resumeAsyncPolling(makeTask(), makeStopSignal());

    expect(mocks.pollUpstreamTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", upstreamTaskId: "up-1", logChannel: "resume_poll" })
    );
    expect(mocks.finalizeGeneratedResult).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        userId: 1,
        startedAt: STARTED_AT,
        urls: ["u1"],
        text: "t",
      })
    );
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("轮询失败 → safeFailTask 透传 error 与 errorCode", async () => {
    mocks.pollUpstreamTask.mockResolvedValue({
      kind: "failed",
      error: "异步轮询超时（upstream_task_id=up-1）",
      errorCode: "generation.poll_timeout",
    });

    await resumeAsyncPolling(makeTask(), makeStopSignal());

    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      { error: "异步轮询超时（upstream_task_id=up-1）", errorCode: "generation.poll_timeout" },
      { startedAt: STARTED_AT }
    );
    expect(mocks.finalizeGeneratedResult).not.toHaveBeenCalled();
  });

  it("stopped / lost → 终态由取消方或僵尸清理负责，不写任何终态", async () => {
    mocks.pollUpstreamTask.mockResolvedValue({ kind: "stopped" });
    await resumeAsyncPolling(makeTask(), makeStopSignal());

    mocks.pollUpstreamTask.mockResolvedValue({ kind: "lost" });
    await resumeAsyncPolling(makeTask(), makeStopSignal());

    expect(mocks.safeFailTask).not.toHaveBeenCalled();
    expect(mocks.finalizeGeneratedResult).not.toHaveBeenCalled();
  });

  it("预算耗尽 → requeueProcessingAsyncTask 重入队（不重提上游），不写终态", async () => {
    mocks.pollUpstreamTask.mockResolvedValue({
      kind: "exhausted",
      error: "异步轮询超时（upstream_task_id=up-1）",
      errorCode: "generation.poll_timeout",
    });
    mocks.requeueProcessingAsyncTask.mockResolvedValue(true);

    await resumeAsyncPolling(makeTask(), makeStopSignal());

    // 守卫参数：所有权令牌 startedAt + retryCount 预算（WORKER_MAX_RETRIES）
    expect(mocks.requeueProcessingAsyncTask).toHaveBeenCalledWith("task-1", STARTED_AT, 2);
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
    expect(mocks.finalizeGeneratedResult).not.toHaveBeenCalled();
  });

  it("预算耗尽且重入队被拒（retryCount 烧完）→ 落 poll_timeout 终态", async () => {
    mocks.pollUpstreamTask.mockResolvedValue({
      kind: "exhausted",
      error: "异步轮询超时（upstream_task_id=up-1）",
      errorCode: "generation.poll_timeout",
    });
    mocks.requeueProcessingAsyncTask.mockResolvedValue(false);

    await resumeAsyncPolling(makeTask(), makeStopSignal());

    expect(mocks.requeueProcessingAsyncTask).toHaveBeenCalledWith("task-1", STARTED_AT, 2);
    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      { error: "异步轮询超时（upstream_task_id=up-1）", errorCode: "generation.poll_timeout" },
      { startedAt: STARTED_AT }
    );
  });

  it("provider 解析失败 → 兜底失败任务，文案带原因", async () => {
    mocks.getProvider.mockResolvedValue(null);

    await resumeAsyncPolling(makeTask(), makeStopSignal());

    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      { error: expect.stringContaining("Failed to resume polling") },
      { startedAt: STARTED_AT }
    );
    expect(mocks.pollUpstreamTask).not.toHaveBeenCalled();
  });

  it("协议不支持轮询 → 兜底失败任务", async () => {
    mocks.getProtocol.mockReturnValue({ name: "bare" });

    await resumeAsyncPolling(makeTask(), makeStopSignal());

    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      { error: expect.stringContaining("does not support polling") },
      { startedAt: STARTED_AT }
    );
  });

  it("stopSignal.stopped → shouldStop 立即为真（停机不再轮询）", async () => {
    const stopSignal = makeStopSignal();
    await resumeAsyncPolling(makeTask(), stopSignal);

    const pollInput = mocks.pollUpstreamTask.mock.calls[0][0] as {
      shouldStop: () => Promise<boolean>;
    };
    stopSignal.stopped = true;
    await expect(pollInput.shouldStop()).resolves.toBe(true);

    stopSignal.stopped = false;
    mocks.isTaskCancelled.mockResolvedValue(true);
    await expect(pollInput.shouldStop()).resolves.toBe(true);
  });

  it("解析失败时走 safeFailTask 兜底且自身不抛", async () => {
    mocks.getProvider.mockRejectedValue(new Error("db down"));

    await expect(resumeAsyncPolling(makeTask(), makeStopSignal())).resolves.toBeUndefined();
    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      { error: expect.stringContaining("Failed to resume polling") },
      { startedAt: STARTED_AT }
    );
  });
});
