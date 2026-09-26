import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimPendingTasks: vi.fn(),
  cleanupZombieTasks: vi.fn(),
  recoverProcessingTasks: vi.fn(),
  executeTask: vi.fn(),
  resumeAsyncPolling: vi.fn(),
  getConfig: vi.fn(),
  logEvent: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@server/crud/task", () => ({
  claimPendingTasks: mocks.claimPendingTasks,
  cleanupZombieTasks: mocks.cleanupZombieTasks,
  recoverProcessingTasks: mocks.recoverProcessingTasks,
}));
vi.mock("./executor", () => ({ executeTask: mocks.executeTask }));
vi.mock("./resume-polling", () => ({ resumeAsyncPolling: mocks.resumeAsyncPolling }));
vi.mock("@server/core/config", () => ({ getConfig: mocks.getConfig }));
vi.mock("@server/core/logger/utils", () => ({ logEvent: mocks.logEvent }));
vi.mock("@server/core/logger", () => ({ logger: { error: mocks.loggerError } }));

import { sleepWithStopSignal, workerLoop } from "./loop";
import type { HydratedGenerationTask } from "@server/crud/task";

function task(id: string): HydratedGenerationTask {
  return { id } as HydratedGenerationTask;
}

function config(overrides: Record<string, number> = {}) {
  return {
    WORKER_MAX_CONCURRENCY: 2,
    WORKER_POLL_INTERVAL: 0.01,
    WORKER_POLL_CHECK_INTERVAL: 1,
    WORKER_ZOMBIE_INTERVAL: 60,
    WORKER_STUCK_TIMEOUT: 15,
    WORKER_MAX_RETRIES: 2,
    WORKER_DRAIN_TIMEOUT: 0.01,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.getConfig.mockReturnValue(config());
  mocks.recoverProcessingTasks.mockResolvedValue({ recovered: 0, asyncTasks: [] });
  mocks.cleanupZombieTasks.mockResolvedValue(0);
  mocks.claimPendingTasks.mockResolvedValue([]);
  mocks.executeTask.mockResolvedValue(undefined);
  mocks.resumeAsyncPolling.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sleepWithStopSignal", () => {
  it("正常超时路径同时清理 timeout 与 stop 检查 interval", async () => {
    const promise = sleepWithStopSignal(1000, 10, { stopped: false });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("停机信号路径同时清理 timeout 与 stop 检查 interval", async () => {
    const stopSignal = { stopped: false };
    const promise = sleepWithStopSignal(1000, 10, stopSignal);

    stopSignal.stopped = true;
    await vi.advanceTimersByTimeAsync(10);
    await promise;

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("workerLoop", () => {
  it("只按空闲并发槽认领任务，而不是每次都认领最大并发数", async () => {
    const stopSignal = { stopped: false };
    let resolveExecution!: () => void;
    mocks.executeTask.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveExecution = resolve;
      }),
    );
    mocks.claimPendingTasks.mockResolvedValueOnce([task("task-1")]);

    const loop = workerLoop(stopSignal);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.claimPendingTasks).toHaveBeenNthCalledWith(1, 2);

    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.claimPendingTasks).toHaveBeenNthCalledWith(2, 1);
    expect(mocks.claimPendingTasks).toHaveBeenCalledTimes(2);

    resolveExecution();
    stopSignal.stopped = true;
    await vi.advanceTimersByTimeAsync(20);
    await loop;
  });

  it("启动恢复的异步轮询也进入同一个 p-limit 调度器", async () => {
    mocks.getConfig.mockReturnValue(config({ WORKER_MAX_CONCURRENCY: 1 }));
    const stopSignal = { stopped: false };
    const resumptions: Array<() => void> = [];
    mocks.recoverProcessingTasks.mockResolvedValue({
      recovered: 0,
      asyncTasks: [task("resume-1"), task("resume-2")],
    });
    mocks.resumeAsyncPolling.mockImplementation(
      () => new Promise<void>((resolve) => {
        resumptions.push(resolve);
      }),
    );

    const loop = workerLoop(stopSignal);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.resumeAsyncPolling).toHaveBeenCalledTimes(1);
    expect(mocks.claimPendingTasks).not.toHaveBeenCalled();

    resumptions[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.resumeAsyncPolling).toHaveBeenCalledTimes(2);

    resumptions[1]();
    stopSignal.stopped = true;
    await vi.advanceTimersByTimeAsync(20);
    await loop;
  });
});
