/**
 * 任务管理器回归测试（specs/task-queue-bullmq.md 规则 1/3）。
 * 锁定 submitAndWait 提交边界分支：提交闸门紧贴 fetch（拒绝即抛闸门错误不发上游）/
 * 同步完成 / 模糊失败归 submission_uncertain（绝不自动重发）/
 * safe-rejection（4xx 除 408/425）沿用现行分类 / 错误体提取 task_id 升级异步受理 /
 * 受理落库（含首 tick 时间）/ 守卫拒绝 / 落库重试耗尽的诚实失败 / signal 贯穿。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchUpstream: vi.fn(),
  httpUpstreamFailure: vi.fn(),
  noUpstreamResult: vi.fn(),
  acceptUpstreamTask: vi.fn(),
  isTaskCancelled: vi.fn(),
  takeSubmissionGate: vi.fn(),
  logEvent: vi.fn(),
  errText: vi.fn((e: unknown) => String(e)),
}));

vi.mock("@server/services/tasks/sync-fetch", () => ({
  fetchUpstream: mocks.fetchUpstream,
  httpUpstreamFailure: mocks.httpUpstreamFailure,
  noUpstreamResult: mocks.noUpstreamResult,
}));
vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());
vi.mock("@server/core/logger/utils", () => ({
  logEvent: mocks.logEvent,
  errText: mocks.errText,
}));
vi.mock("@server/crud/task", () => ({
  acceptUpstreamTask: mocks.acceptUpstreamTask,
  isTaskCancelled: mocks.isTaskCancelled,
  takeSubmissionGate: mocks.takeSubmissionGate,
}));

import { submitAndWait } from "@server/services/tasks/manager";
import { GenerationGateRejectedError } from "@server/services/tasks/failure";
import { resetTestSettings } from "../../helpers/settings";

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
  resetTestSettings({
    "worker.async_poll_initial_delay_seconds": 0,
  });
  mocks.isTaskCancelled.mockResolvedValue(false);
  mocks.acceptUpstreamTask.mockResolvedValue(true);
  mocks.takeSubmissionGate.mockResolvedValue(true);
  protocol.extractTaskId.mockReturnValue(undefined);
});

describe("submitAndWait", () => {
  it("提交闸门紧贴 fetch：拒绝 → 抛闸门错误，上游请求不发（规则 3）", async () => {
    mocks.takeSubmissionGate.mockResolvedValue(false);

    await expect(submitAndWait(makeInput())).rejects.toBeInstanceOf(GenerationGateRejectedError);
    expect(mocks.fetchUpstream).not.toHaveBeenCalled();
  });

  it("同步响应含结果 → completed，不进入异步受理", async () => {
    mocks.fetchUpstream.mockResolvedValue({ kind: "data", data: { url: "u" } });

    const result = await submitAndWait(makeInput({
      parseResponse: () => ({ urls: ["u1"] }),
    }));

    expect(result).toMatchObject({ status: "completed", urls: ["u1"] });
    expect(mocks.acceptUpstreamTask).not.toHaveBeenCalled();
  });

  it("提交失败（超时/网络）→ submission_uncertain 留痕：请求可能已在途，绝不区分细节重发", async () => {
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
      errorCode: "generation.submission_uncertain",
    });
  });

  it("HTTP 错误体中携带 task_id → 视为上游已受理，升级为异步受理（含首 tick 时间落库）", async () => {
    mocks.fetchUpstream.mockResolvedValue({
      kind: "http-error",
      status: 500,
      errText: "{}",
      errData: { task_id: "up-1" },
    });
    protocol.extractTaskId.mockReturnValue("up-1");

    const result = await submitAndWait(makeInput());

    expect(result).toEqual({ status: "async", urls: [], asyncNextPollAt: expect.any(Date) });
    expect(mocks.acceptUpstreamTask).toHaveBeenCalledWith(
      "task-1",
      "up-1",
      STARTED_AT,
      expect.any(Date)
    );
  });

  it("提取到 task_id 时任务已被取消 → cancelled，不落库受理", async () => {
    mocks.fetchUpstream.mockResolvedValue({ kind: "data", data: { task_id: "up-1" } });
    protocol.extractTaskId.mockReturnValue("up-1");
    mocks.isTaskCancelled.mockResolvedValue(true);

    const result = await submitAndWait(makeInput());

    expect(result).toEqual({ status: "cancelled", urls: [] });
    expect(mocks.acceptUpstreamTask).not.toHaveBeenCalled();
  });

  it("5xx 无 task_id → 提交结果不确定（经网关转发无法判断源站是否已建任务）", async () => {
    mocks.fetchUpstream.mockResolvedValue({
      kind: "http-error",
      status: 500,
      errText: "boom",
      errData: { error: { message: "boom" } },
    });

    const result = await submitAndWait(makeInput());

    expect(result).toEqual({
      status: "failed",
      urls: [],
      error: "上游提交结果不确定（HTTP 500），为避免重复提交已放弃重试",
      errorCode: "generation.submission_uncertain",
    });
    expect(mocks.httpUpstreamFailure).not.toHaveBeenCalled();
  });

  it("408/425 同样归入提交不确定（无法排除上游已受理）", async () => {
    for (const status of [408, 425]) {
      mocks.fetchUpstream.mockResolvedValue({
        kind: "http-error",
        status,
        errText: "{}",
        errData: {},
      });

      const result = await submitAndWait(makeInput());

      expect(result).toMatchObject({ status: "failed", errorCode: "generation.submission_uncertain" });
    }
  });

  it("4xx 明确拒绝（含 429 限流）→ 沿用 httpUpstreamFailure 现行分类", async () => {
    for (const status of [400, 401, 403, 404, 429]) {
      mocks.fetchUpstream.mockResolvedValue({
        kind: "http-error",
        status,
        errText: "rejected",
        errData: {},
      });
      mocks.httpUpstreamFailure.mockReturnValue({ error: "rejected", errorCode: "generation.upstream_rejected" });

      const result = await submitAndWait(makeInput());

      expect(result).toEqual({
        status: "failed",
        urls: [],
        error: "rejected",
        errorCode: "generation.upstream_rejected",
      });
      expect(mocks.httpUpstreamFailure).toHaveBeenLastCalledWith(status, "rejected");
    }
  });

  it("响应体含 task_id → 异步受理落库成功，返回 async（携带首 tick 时间）", async () => {
    mocks.fetchUpstream.mockResolvedValue({ kind: "data", data: { task_id: "up-1" } });
    protocol.extractTaskId.mockReturnValue("up-1");

    const result = await submitAndWait(makeInput());

    expect(result.status).toBe("async");
    // 首 tick 延迟单源：结果携带与落库相同的首个 nextPollAt
    const firstPollAt = mocks.acceptUpstreamTask.mock.calls[0][3] as Date;
    expect(result.asyncNextPollAt).toBe(firstPollAt);
  });

  it("受理落库被守卫拒绝 → ownership lost（任务已离开本次认领，不写终态不重试）", async () => {
    mocks.fetchUpstream.mockResolvedValue({ kind: "data", data: { task_id: "up-1" } });
    protocol.extractTaskId.mockReturnValue("up-1");
    mocks.acceptUpstreamTask.mockResolvedValue(false);

    const result = await submitAndWait(makeInput());

    expect(result).toEqual({ status: "failed", urls: [], error: "Task ownership lost" });
    expect(mocks.acceptUpstreamTask).toHaveBeenCalledTimes(1);
  });

  it("受理落库持续抛错（DB 不可用）→ 3 次重试后诚实失败 submission_uncertain", async () => {
    mocks.fetchUpstream.mockResolvedValue({ kind: "data", data: { task_id: "up-1" } });
    protocol.extractTaskId.mockReturnValue("up-1");
    mocks.acceptUpstreamTask.mockRejectedValue(new Error("db down"));

    const result = await submitAndWait(makeInput());

    expect(mocks.acceptUpstreamTask).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "generation.submission_uncertain",
    });
    expect(result.error).toContain("落库失败");
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

  it("signal 贯穿提交请求（停机 drain 超时可中止在途提交）", async () => {
    const controller = new AbortController();
    mocks.fetchUpstream.mockResolvedValue({ kind: "data", data: {} });

    await submitAndWait(makeInput({ signal: controller.signal }));

    expect(mocks.fetchUpstream).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://upstream.test/v1/x" }),
      "task-1",
      "taskmgr",
      controller.signal
    );
  });
});
