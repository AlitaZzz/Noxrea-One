/**
 * 提交段执行器回归测试（specs/task-queue-bullmq.md 规则 1/3）。
 * 锁定：闸门拒绝（能力层抛出）静默收口、异步受理信号原位调度首 tick（DelayedError
 * 传播 / defer 失败自愈）、LLM 纯文本直完、URL 结果走下载编排、失败/取消的终态写入
 * 语义、引用每次执行即时重签且解析结果只进上游请求、不回写任务行。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DelayedError } from "bullmq";

const mocks = vi.hoisted(() => ({
  routeGenerate: vi.fn(),
  safeCompleteTask: vi.fn(),
  safeFailTask: vi.fn(),
  deferActiveTickOrThrow: vi.fn(),
  getProvider: vi.fn(),
  resolveRefImages: vi.fn(),
  resolveRefAudio: vi.fn(),
  resolveRefVideo: vi.fn(),
  resolveAndValidate: vi.fn(),
  getModelParams: vi.fn(),
  modelFieldDefaults: vi.fn(),
  buildContext: vi.fn(),
  finalizeGeneratedResult: vi.fn(),
  logEvent: vi.fn(),
  classifyError: vi.fn(),
}));

vi.mock("@server/services/gateway/router", () => ({ routeGenerate: mocks.routeGenerate }));
vi.mock("@server/crud/task", () => ({
  safeCompleteTask: mocks.safeCompleteTask,
  safeFailTask: mocks.safeFailTask,
}));
vi.mock("@server/crud/model-config", () => ({ getProvider: mocks.getProvider }));
vi.mock("@server/services/resolvers/reference", () => ({
  resolveRefImages: mocks.resolveRefImages,
  resolveRefAudio: mocks.resolveRefAudio,
  resolveRefVideo: mocks.resolveRefVideo,
}));
vi.mock("@server/core/ssrf", () => ({ resolveAndValidate: mocks.resolveAndValidate }));
vi.mock("@server/services/model-config", () => ({
  getModelParams: mocks.getModelParams,
  modelFieldDefaults: mocks.modelFieldDefaults,
  hostFromBaseUrl: vi.fn(() => "upstream.test"),
}));
vi.mock("@server/services/worker/context", () => ({ buildContext: mocks.buildContext }));
vi.mock("@server/services/worker/queue", () => ({
  deferActiveTickOrThrow: mocks.deferActiveTickOrThrow,
}));
vi.mock("@server/services/worker/download-results", () => ({ finalizeGeneratedResult: mocks.finalizeGeneratedResult }));
vi.mock("@server/core/logger/utils", () => ({
  logEvent: mocks.logEvent,
  errText: (e: unknown) => String(e),
  classifyError: mocks.classifyError,
}));
vi.mock("@server/core/logger", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import { executeSubmissionPhase } from "@server/services/worker/executor";
import {
  GenerationFailureError,
  GenerationCancelledError,
  GenerationAsyncDispatchedError,
  GenerationGateRejectedError,
} from "@server/services/tasks/failure";
import type { TickDeferContext } from "@server/services/worker/queue";
import type { HydratedGenerationTask } from "@server/crud/task";

const STARTED_AT = new Date("2026-01-01T00:00:00.000Z");

/** 自调度上下文 stub：job.moveToDelayed 可注入 */
function makeDeferCtx(): TickDeferContext & { job: { moveToDelayed: ReturnType<typeof vi.fn> } } {
  return { job: { moveToDelayed: vi.fn() }, token: "tok" } as never;
}

function makeTask(overrides: Partial<Record<string, unknown>> = {}): HydratedGenerationTask {
  return {
    id: "task-1",
    userId: 1,
    type: "image",
    protocol: "openai",
    model: "m-1",
    prompt: "p",
    config: { providerId: 7 },
    startedAt: STARTED_AT,
    submissionState: "not_sent",
    ...overrides,
  } as unknown as HydratedGenerationTask;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deferActiveTickOrThrow.mockResolvedValue(undefined);
  mocks.getProvider.mockResolvedValue({ baseUrl: "http://upstream.test/", apiKey: "key", protocol: "openai" });
  mocks.resolveRefImages.mockResolvedValue([]);
  mocks.resolveRefAudio.mockResolvedValue([]);
  mocks.resolveRefVideo.mockResolvedValue([]);
  mocks.resolveAndValidate.mockResolvedValue(undefined);
  mocks.getModelParams.mockReturnValue(null);
  mocks.modelFieldDefaults.mockReturnValue({});
  mocks.buildContext.mockReturnValue({ config: { providerId: 7 }, refImages: [], refAudios: [], refVideos: [] });
  mocks.classifyError.mockReturnValue(["generic", false]);
  mocks.routeGenerate.mockResolvedValue({ urls: [], text: "" });
  mocks.finalizeGeneratedResult.mockResolvedValue(undefined);
  mocks.safeCompleteTask.mockResolvedValue({ id: "task-1" });
  mocks.safeFailTask.mockResolvedValue({ id: "task-1" });
});

describe("executeSubmissionPhase", () => {
  it("URL 结果：routeGenerate → 终态编排单源 finalizeGeneratedResult", async () => {
    mocks.routeGenerate.mockResolvedValue({ urls: ["http://cdn/x.png"], text: "" });
    const ctx = makeDeferCtx();

    await executeSubmissionPhase(makeTask(), new AbortController().signal, ctx);

    expect(mocks.finalizeGeneratedResult).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        userId: 1,
        startedAt: STARTED_AT,
        urls: ["http://cdn/x.png"],
      })
    );
    expect(mocks.safeCompleteTask).not.toHaveBeenCalled();
  });

  it("闸门拒绝（能力层提交点抛出）→ 静默收口：不提交不写终态", async () => {
    mocks.routeGenerate.mockRejectedValue(new GenerationGateRejectedError());

    await executeSubmissionPhase(makeTask(), new AbortController().signal, makeDeferCtx());

    expect(mocks.safeFailTask).not.toHaveBeenCalled();
    expect(mocks.safeCompleteTask).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith(
      "executor",
      expect.objectContaining({ stage: "submission_gate_rejected" })
    );
  });

  it("LLM 纯文本结果 → 直接 safeCompleteTask，不走 URL 下载", async () => {
    mocks.routeGenerate.mockResolvedValue({ urls: [], text: "hello" });

    await executeSubmissionPhase(makeTask({ type: "llm" }), new AbortController().signal, makeDeferCtx());

    expect(mocks.safeCompleteTask).toHaveBeenCalledWith(
      "task-1",
      { resultText: "hello" },
      { startedAt: STARTED_AT }
    );
    expect(mocks.finalizeGeneratedResult).not.toHaveBeenCalled();
  });

  it("GenerationAsyncDispatchedError → 以落库的 nextPollAt 原位调度首 tick，DelayedError 传播回 processor", async () => {
    const nextPollAt = new Date(Date.now() + 500);
    mocks.routeGenerate.mockRejectedValue(new GenerationAsyncDispatchedError(nextPollAt));
    mocks.deferActiveTickOrThrow.mockImplementation(async () => {
      throw new DelayedError();
    });
    const ctx = makeDeferCtx();

    await expect(
      executeSubmissionPhase(makeTask(), new AbortController().signal, ctx)
    ).rejects.toBeInstanceOf(DelayedError);

    expect(mocks.deferActiveTickOrThrow).toHaveBeenCalledWith(ctx, "task-1", nextPollAt);
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
    expect(mocks.safeCompleteTask).not.toHaveBeenCalled();
  });

  it("首 tick 原位调度失败（defer 返回）不致命：不写终态不抛错，nextPollAt 已落库交清扫自愈", async () => {
    mocks.routeGenerate.mockRejectedValue(
      new GenerationAsyncDispatchedError(new Date(Date.now() + 500))
    );
    mocks.deferActiveTickOrThrow.mockResolvedValue(undefined);

    await expect(
      executeSubmissionPhase(makeTask(), new AbortController().signal, makeDeferCtx())
    ).resolves.toBeUndefined();

    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("GenerationFailureError → safeFailTask 携带原始文案与错误码", async () => {
    mocks.routeGenerate.mockRejectedValue(
      new GenerationFailureError("quota exceeded", "generation.upstream_no_result")
    );
    mocks.classifyError.mockReturnValue(["upstream", false]);

    await executeSubmissionPhase(makeTask(), new AbortController().signal, makeDeferCtx());

    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      { error: "quota exceeded", errorCode: "generation.upstream_no_result" },
      { startedAt: STARTED_AT }
    );
  });

  it("GenerationCancelledError → 不写任何失败终态", async () => {
    mocks.routeGenerate.mockRejectedValue(new GenerationCancelledError());

    await executeSubmissionPhase(makeTask(), new AbortController().signal, makeDeferCtx());

    expect(mocks.safeFailTask).not.toHaveBeenCalled();
    expect(mocks.safeCompleteTask).not.toHaveBeenCalled();
  });

  it("重试重签：每次执行即时解析引用，解析结果只进上游请求、不回写任务行", async () => {
    const KEY = `3/ab/${"a".repeat(64)}.png`;
    const task = makeTask({ refImages: [KEY] });
    mocks.buildContext.mockReturnValue({ config: { providerId: 7 }, refImages: [KEY], refAudios: [], refVideos: [] });
    let attempt = 0;
    mocks.resolveRefImages.mockImplementation(async () => [`https://sig.example/attempt-${++attempt}`]);

    await executeSubmissionPhase(task, new AbortController().signal, makeDeferCtx());
    await executeSubmissionPhase(task, new AbortController().signal, makeDeferCtx()); // 重试 = 重新认领后再执行，解析天然重跑

    expect(mocks.resolveRefImages).toHaveBeenCalledTimes(2);
    expect(mocks.resolveRefImages).toHaveBeenNthCalledWith(1, [KEY]);
    expect(mocks.resolveRefImages).toHaveBeenNthCalledWith(2, [KEY]);
    expect(mocks.routeGenerate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ params: expect.objectContaining({ refImages: ["https://sig.example/attempt-1"] }) }),
    );
    expect(mocks.routeGenerate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ params: expect.objectContaining({ refImages: ["https://sig.example/attempt-2"] }) }),
    );
    expect(task.refImages).toEqual([KEY]);
  });

  it("config 缺 providerId（确定性失败）→ 失败落专用错误码，未到提交点", async () => {
    mocks.buildContext.mockReturnValue({ config: {}, refImages: [], refAudios: [], refVideos: [] });

    await executeSubmissionPhase(makeTask({ config: {} }), new AbortController().signal, makeDeferCtx());

    expect(mocks.routeGenerate).not.toHaveBeenCalled();
    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ errorCode: "generation.missing_provider_id" }),
      { startedAt: STARTED_AT }
    );
  });

  it("routeCtx 携带 per-job AbortSignal（停机 drain 超时可中止在途请求）", async () => {
    const signal = new AbortController().signal;
    await executeSubmissionPhase(makeTask(), signal, makeDeferCtx());

    expect(mocks.routeGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ signal })
    );
  });
});
