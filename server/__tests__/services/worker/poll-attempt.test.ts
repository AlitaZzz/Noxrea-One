/**
 * 单次轮询尝试测试（specs/task-queue-bullmq.md 规则 1 tick 化）：
 * completed/failed 走终态编排、pending/error 推进下一延迟 tick（含 60 轮后间隔翻倍）、
 * 预算耗尽重入队（原位重跑继续轮询，不重提上游）、重入队预算烧完才落 poll_timeout、
 * 构建轮询请求的确定性失败、停机中止不调度不判死、DelayedError 传播回 processor。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DelayedError } from "bullmq";

const mocks = vi.hoisted(() => ({
  pollUpstreamOnce: vi.fn(),
  safeFailTask: vi.fn(),
  requeueProcessingAsyncTask: vi.fn(),
  deferPollTick: vi.fn(),
  deferActiveTickOrThrow: vi.fn(),
  finalizeGeneratedResult: vi.fn(),
  getSetting: vi.fn(),
  getProvider: vi.fn(),
  getProtocol: vi.fn(),
  buildPollUrl: vi.fn(),
  resolveProviderEndpoints: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@server/services/tasks/poll-loop", () => ({ pollUpstreamOnce: mocks.pollUpstreamOnce }));
vi.mock("@server/crud/task", () => ({
  safeFailTask: mocks.safeFailTask,
  requeueProcessingAsyncTask: mocks.requeueProcessingAsyncTask,
  deferPollTick: mocks.deferPollTick,
}));
vi.mock("@server/services/worker/queue", () => ({
  deferActiveTickOrThrow: mocks.deferActiveTickOrThrow,
}));
vi.mock("@server/services/worker/download-results", () => ({
  finalizeGeneratedResult: mocks.finalizeGeneratedResult,
}));
vi.mock("@server/core/settings", () => ({ getSetting: mocks.getSetting }));
vi.mock("@server/crud/model-config", () => ({ getProvider: mocks.getProvider }));
vi.mock("@server/services/protocols/base", () => ({ getProtocol: mocks.getProtocol }));
vi.mock("@server/services/model-config", () => ({
  resolveProviderEndpoints: mocks.resolveProviderEndpoints,
  hostFromBaseUrl: vi.fn(() => "upstream.test"),
}));
vi.mock("@server/core/logger/utils", () => ({
  logEvent: mocks.logEvent,
  errText: (e: unknown) => String(e),
}));
vi.mock("@server/core/logger", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import { runPollAttempt } from "@server/services/worker/poll-attempt";
import type { TickDeferContext } from "@server/services/worker/queue";
import type { HydratedGenerationTask } from "@server/crud/task";

const STARTED_AT = new Date("2026-01-01T11:00:00.000Z");

/** 自调度上下文 stub */
const makeDeferCtx = () => ({ job: { moveToDelayed: vi.fn() }, token: "tok" }) as never as TickDeferContext;

function makeTask(overrides: Partial<Record<string, unknown>> = {}): HydratedGenerationTask {
  return {
    id: "task-1",
    userId: 1,
    type: "image",
    protocol: "openai",
    model: "m-1",
    startedAt: STARTED_AT,
    upstreamTaskId: "up-1",
    asyncPollAttempts: 0,
    config: { providerId: 7 },
    ...overrides,
  } as unknown as HydratedGenerationTask;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockImplementation((key: string) => {
    if (key === "worker.async_poll_interval_seconds") return 3;
    if (key === "worker.async_poll_max_attempts") return 120;
    if (key === "worker.max_retries") return 2;
    throw new Error(`unexpected getSetting(${key})`);
  });
  mocks.getProvider.mockResolvedValue({ baseUrl: "http://upstream.test/", apiKey: "key", protocol: "openai" });
  mocks.getProtocol.mockReturnValue({ buildPollUrl: mocks.buildPollUrl });
  mocks.buildPollUrl.mockReturnValue("https://upstream.test/tasks/up-1");
  mocks.resolveProviderEndpoints.mockReturnValue({});
  mocks.safeFailTask.mockResolvedValue({ id: "task-1" });
  mocks.requeueProcessingAsyncTask.mockResolvedValue(true);
  mocks.deferPollTick.mockResolvedValue(true);
  mocks.deferActiveTickOrThrow.mockResolvedValue(undefined);
  mocks.finalizeGeneratedResult.mockResolvedValue(true);
});

describe("runPollAttempt", () => {
  it("completed → 终态编排单源 finalizeGeneratedResult（下载落盘 + safe 终态）", async () => {
    mocks.pollUpstreamOnce.mockResolvedValue({ kind: "completed", urls: ["http://cdn/x.png"], text: "t" });

    await runPollAttempt(makeTask(), new AbortController().signal, makeDeferCtx());

    expect(mocks.finalizeGeneratedResult).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        userId: 1,
        startedAt: STARTED_AT,
        urls: ["http://cdn/x.png"],
        text: "t",
      })
    );
    expect(mocks.deferPollTick).not.toHaveBeenCalled();
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("failed → safeFailTask 透传上游文案与错误码", async () => {
    mocks.pollUpstreamOnce.mockResolvedValue({ kind: "failed", error: "boom", errorCode: "generation.upstream_rejected" });

    await runPollAttempt(makeTask(), new AbortController().signal, makeDeferCtx());

    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      { error: "boom", errorCode: "generation.upstream_rejected" },
      { startedAt: STARTED_AT }
    );
  });

  it("pending → 写 nextPollAt + 尝试计数（deferPollTick）并原位 moveToDelayed 至同一时刻", async () => {
    mocks.pollUpstreamOnce.mockResolvedValue({ kind: "pending" });
    const before = Date.now();
    const ctx = makeDeferCtx();

    await runPollAttempt(makeTask(), new AbortController().signal, ctx);

    expect(mocks.deferPollTick).toHaveBeenCalledWith(
      "task-1",
      STARTED_AT,
      expect.any(Date),
      1
    );
    const nextPollAt = mocks.deferPollTick.mock.calls[0][2] as Date;
    expect(nextPollAt.getTime()).toBeGreaterThanOrEqual(before + 3000);
    // 原位自调度与 DB 落点同源：同一 Date 引用
    expect(mocks.deferActiveTickOrThrow).toHaveBeenCalledWith(ctx, "task-1", nextPollAt);
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("达到退避阈值（第 60 轮起）间隔翻倍", async () => {
    mocks.pollUpstreamOnce.mockResolvedValue({ kind: "pending" });

    await runPollAttempt(makeTask({ asyncPollAttempts: 59 }), new AbortController().signal, makeDeferCtx());
    expect(mocks.deferPollTick).toHaveBeenLastCalledWith("task-1", STARTED_AT, expect.any(Date), 60);
    expect(mocks.deferPollTick.mock.lastCall![2].getTime()).toBeGreaterThanOrEqual(Date.now() + 6000 - 100);

    await runPollAttempt(makeTask({ asyncPollAttempts: 58 }), new AbortController().signal, makeDeferCtx());
    expect(mocks.deferPollTick).toHaveBeenLastCalledWith("task-1", STARTED_AT, expect.any(Date), 59);
    expect(mocks.deferPollTick.mock.lastCall![2].getTime()).toBeGreaterThanOrEqual(Date.now() + 3000 - 100);
  });

  it("error kind（网络异常）同样推进下一 tick，不判死", async () => {
    mocks.pollUpstreamOnce.mockResolvedValue({ kind: "error", error: "ETIMEDOUT" });

    await runPollAttempt(makeTask({ asyncPollAttempts: 5 }), new AbortController().signal, makeDeferCtx());

    expect(mocks.deferPollTick).toHaveBeenCalledWith("task-1", STARTED_AT, expect.any(Date), 6);
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("尝试预算耗尽 → 重入队（重置 pending + retryCount+1）后原位立即重跑，不重提上游", async () => {
    mocks.pollUpstreamOnce.mockResolvedValue({ kind: "pending" });
    const before = Date.now();
    const ctx = makeDeferCtx();

    await runPollAttempt(makeTask({ asyncPollAttempts: 119 }), new AbortController().signal, ctx);

    expect(mocks.requeueProcessingAsyncTask).toHaveBeenCalledWith("task-1", STARTED_AT, 2);
    expect(mocks.deferActiveTickOrThrow).toHaveBeenCalledWith(ctx, "task-1", expect.any(Date));
    const delayUntil = mocks.deferActiveTickOrThrow.mock.calls[0][2] as Date;
    expect(delayUntil.getTime()).toBeGreaterThanOrEqual(before);
    expect(delayUntil.getTime()).toBeLessThanOrEqual(Date.now());
    expect(mocks.deferPollTick).not.toHaveBeenCalled();
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("重入队预算烧完（requeue 返回 false）→ 才落 poll_timeout 终态", async () => {
    mocks.pollUpstreamOnce.mockResolvedValue({ kind: "pending" });
    mocks.requeueProcessingAsyncTask.mockResolvedValue(false);

    await runPollAttempt(makeTask({ asyncPollAttempts: 119 }), new AbortController().signal, makeDeferCtx());

    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ errorCode: "generation.poll_timeout" }),
      { startedAt: STARTED_AT }
    );
    expect(mocks.deferActiveTickOrThrow).not.toHaveBeenCalled();
  });

  it("重入队后原位重跑失败（defer 返回）不致命：不抛错不判死，pending 行交清扫自愈", async () => {
    mocks.pollUpstreamOnce.mockResolvedValue({ kind: "pending" });
    mocks.requeueProcessingAsyncTask.mockResolvedValue(true);
    mocks.deferActiveTickOrThrow.mockResolvedValue(undefined);

    await expect(
      runPollAttempt(makeTask({ asyncPollAttempts: 119 }), new AbortController().signal, makeDeferCtx())
    ).resolves.toBeUndefined();

    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("原位重跑成功 → DelayedError 传播回 processor（worker 据此跳过 finalize）", async () => {
    mocks.pollUpstreamOnce.mockResolvedValue({ kind: "pending" });
    mocks.requeueProcessingAsyncTask.mockResolvedValue(true);
    mocks.deferActiveTickOrThrow.mockRejectedValue(new DelayedError());

    await expect(
      runPollAttempt(makeTask({ asyncPollAttempts: 119 }), new AbortController().signal, makeDeferCtx())
    ).rejects.toBeInstanceOf(DelayedError);
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("deferPollTick 被守卫拒绝（已失权）→ 不调度", async () => {
    mocks.pollUpstreamOnce.mockResolvedValue({ kind: "pending" });
    mocks.deferPollTick.mockResolvedValue(false);

    await runPollAttempt(makeTask(), new AbortController().signal, makeDeferCtx());

    expect(mocks.deferActiveTickOrThrow).not.toHaveBeenCalled();
  });

  it("defer 后原位调度失败（defer 返回）不致命：nextPollAt 已落库，tick 逾期后清扫自愈", async () => {
    mocks.pollUpstreamOnce.mockResolvedValue({ kind: "pending" });
    mocks.deferActiveTickOrThrow.mockResolvedValue(undefined);

    await expect(
      runPollAttempt(makeTask(), new AbortController().signal, makeDeferCtx())
    ).resolves.toBeUndefined();

    expect(mocks.deferPollTick).toHaveBeenCalled();
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("轮询请求构建失败（供应商配置缺失）→ 确定性失败，直接判终态", async () => {
    mocks.getProvider.mockResolvedValue(null);

    await runPollAttempt(makeTask(), new AbortController().signal, makeDeferCtx());

    expect(mocks.pollUpstreamOnce).not.toHaveBeenCalled();
    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ error: expect.stringContaining("Failed to poll upstream task") }),
      { startedAt: STARTED_AT }
    );
  });

  it("停机中止（signal 已 abort）→ 不轮询不调度不判死，交 stalled/清扫收口", async () => {
    const controller = new AbortController();
    controller.abort();

    await runPollAttempt(makeTask(), controller.signal, makeDeferCtx());

    expect(mocks.pollUpstreamOnce).not.toHaveBeenCalled();
    expect(mocks.deferPollTick).not.toHaveBeenCalled();
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("轮询期间被中止（error + signal.aborted）→ 不调度下一 tick", async () => {
    const controller = new AbortController();
    mocks.pollUpstreamOnce.mockImplementation(async () => {
      controller.abort();
      return { kind: "error", error: "This operation was aborted" };
    });

    await runPollAttempt(makeTask(), controller.signal, makeDeferCtx());

    expect(mocks.deferPollTick).not.toHaveBeenCalled();
    expect(mocks.deferActiveTickOrThrow).not.toHaveBeenCalled();
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });
});
