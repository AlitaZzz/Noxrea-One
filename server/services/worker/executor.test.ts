/**
 * 单任务执行器回归测试。
 * 锁定：upstreamTaskId 恢复轮询不重提、LLM 纯文本直完、URL 结果走下载编排、
 * 失败/取消的终态写入语义（GenerationFailureError 带 errorCode、取消不写失败）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  routeGenerate: vi.fn(),
  safeCompleteTask: vi.fn(),
  safeFailTask: vi.fn(),
  getProvider: vi.fn(),
  resolveRefImages: vi.fn(),
  resolveRefAudio: vi.fn(),
  resolveRefVideo: vi.fn(),
  resolveAndValidate: vi.fn(),
  getModelParams: vi.fn(),
  modelFieldDefaults: vi.fn(),
  buildContext: vi.fn(),
  resumeAsyncPolling: vi.fn(),
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
vi.mock("./context", () => ({ buildContext: mocks.buildContext }));
vi.mock("./resume-polling", () => ({ resumeAsyncPolling: mocks.resumeAsyncPolling }));
vi.mock("./download-results", () => ({ finalizeGeneratedResult: mocks.finalizeGeneratedResult }));
vi.mock("@server/core/logger/utils", () => ({
  logEvent: mocks.logEvent,
  classifyError: mocks.classifyError,
}));

import { executeTask } from "./executor";
import {
  GenerationFailureError,
  GenerationCancelledError,
  GenerationRequeuedError,
} from "@server/services/tasks/failure";
import type { StopSignal } from "./loop";
import type { HydratedGenerationTask } from "@server/crud/task";

const STARTED_AT = new Date("2026-01-01T00:00:00.000Z");

function makeStopSignal(): StopSignal {
  const controller = new AbortController();
  return { stopped: false, signal: controller.signal, abort: () => controller.abort() };
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
    ...overrides,
  } as unknown as HydratedGenerationTask;
}

beforeEach(() => {
  vi.clearAllMocks();
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
  mocks.resumeAsyncPolling.mockResolvedValue(undefined);
  mocks.safeCompleteTask.mockResolvedValue({ id: "task-1" });
  mocks.safeFailTask.mockResolvedValue({ id: "task-1" });
});

describe("executeTask", () => {
  it("已有 upstreamTaskId → 恢复轮询，绝不再次提交上游", async () => {
    const task = makeTask({ upstreamTaskId: "up-1" });
    const stopSignal = makeStopSignal();

    await executeTask(task, stopSignal);

    expect(mocks.resumeAsyncPolling).toHaveBeenCalledWith(task, stopSignal);
    expect(mocks.routeGenerate).not.toHaveBeenCalled();
    expect(mocks.getProvider).not.toHaveBeenCalled();
  });

  it("LLM 纯文本结果 → 直接 safeCompleteTask，不走 URL 下载", async () => {
    const task = makeTask({ type: "llm" });
    mocks.routeGenerate.mockResolvedValue({ urls: [], text: "hello" });

    await executeTask(task, makeStopSignal());

    expect(mocks.safeCompleteTask).toHaveBeenCalledWith(
      "task-1",
      { resultText: "hello" },
      { startedAt: STARTED_AT }
    );
    expect(mocks.finalizeGeneratedResult).not.toHaveBeenCalled();
  });

  it("URL 结果 → 终态编排单源 finalizeGeneratedResult（下载落盘 + safe 终态）", async () => {
    mocks.routeGenerate.mockResolvedValue({ urls: ["http://cdn/x.png"], text: "" });

    await executeTask(makeTask(), makeStopSignal());

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

  it("GenerationFailureError → safeFailTask 携带原始文案与错误码", async () => {
    mocks.routeGenerate.mockRejectedValue(
      new GenerationFailureError("quota exceeded", "generation.upstream_no_result")
    );
    mocks.classifyError.mockReturnValue(["upstream", false]);

    await executeTask(makeTask(), makeStopSignal());

    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      { error: "quota exceeded", errorCode: "generation.upstream_no_result" },
      { startedAt: STARTED_AT }
    );
  });

  it("GenerationCancelledError → 不写任何失败终态", async () => {
    mocks.routeGenerate.mockRejectedValue(new GenerationCancelledError());

    await executeTask(makeTask(), makeStopSignal());

    expect(mocks.safeFailTask).not.toHaveBeenCalled();
    expect(mocks.safeCompleteTask).not.toHaveBeenCalled();
  });

  it("GenerationRequeuedError → 不写终态（任务已重置 pending，等待重新认领）", async () => {
    mocks.routeGenerate.mockRejectedValue(new GenerationRequeuedError());

    await executeTask(makeTask(), makeStopSignal());

    expect(mocks.safeFailTask).not.toHaveBeenCalled();
    expect(mocks.safeCompleteTask).not.toHaveBeenCalled();
  });

  it("config 缺 providerId → 失败并落专用错误码", async () => {
    mocks.buildContext.mockReturnValue({ config: {}, refImages: [], refAudios: [], refVideos: [] });

    await executeTask(makeTask({ config: {} }), makeStopSignal());

    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ errorCode: "generation.missing_provider_id" }),
      { startedAt: STARTED_AT }
    );
  });

  it("routeCtx 携带 stopSignal 的 AbortSignal（停机收尾可中止在途请求）", async () => {
    const stopSignal = makeStopSignal();
    await executeTask(makeTask(), stopSignal);

    expect(mocks.routeGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ signal: stopSignal.signal })
    );
  });
});
