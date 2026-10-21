/**
 * 任务 job 处理器测试（specs/task-queue-bullmq.md 规则 1 分派矩阵）：
 * pending 认领后按 upstreamTaskId 分派、processing+upstreamTaskId 直入轮询段、
 * processing+未受理的租约新鲜跳过 / in_flight 过期判 submission_uncertain /
 * not_sent 过期接管重提 / 预算耗尽判失败、终态 no-op。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  claimPendingTask: vi.fn(),
  takeOverInterruptedTask: vi.fn(),
  safeFailTask: vi.fn(),
  stuckLeaseCutoff: vi.fn(),
  getSetting: vi.fn(),
  executeSubmissionPhase: vi.fn(),
  runPollAttempt: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@server/crud/task", () => ({
  getTask: mocks.getTask,
  claimPendingTask: mocks.claimPendingTask,
  takeOverInterruptedTask: mocks.takeOverInterruptedTask,
  safeFailTask: mocks.safeFailTask,
  stuckLeaseCutoff: mocks.stuckLeaseCutoff,
  isTerminalTaskStatus: (status: string) =>
    status === "completed" || status === "failed" || status === "cancelled",
}));
vi.mock("@server/core/settings", () => ({ getSetting: mocks.getSetting }));
vi.mock("@server/services/worker/executor", () => ({
  executeSubmissionPhase: mocks.executeSubmissionPhase,
}));
vi.mock("@server/services/worker/poll-attempt", () => ({
  runPollAttempt: mocks.runPollAttempt,
}));
vi.mock("@server/core/logger/utils", () => ({
  logEvent: mocks.logEvent,
  errText: (e: unknown) => String(e),
}));

import { processTaskJob } from "@server/services/worker/handler";
import type { HydratedGenerationTask } from "@server/crud/task";

const STARTED_AT = new Date("2026-01-01T11:00:00.000Z");
/** 租约截止 stub：固定值使新鲜/过期分界与接管谓词断言完全确定 */
const LEASE_CUTOFF = new Date("2026-01-01T10:45:00.000Z");
/** 相对固定截止值的过期租约：必然早于 LEASE_CUTOFF */
const STALE_UPDATED_AT = () => new Date(LEASE_CUTOFF.getTime() - 16 * 60 * 1000);
/** 自调度上下文固定 stub：三处分派原样透传 */
const CTX = { job: { moveToDelayed: () => {} }, token: "tok" } as never;

function makeTask(overrides: Partial<Record<string, unknown>> = {}): HydratedGenerationTask {
  return {
    id: "task-1",
    status: "processing",
    startedAt: STARTED_AT,
    updatedAt: new Date(),
    upstreamTaskId: null,
    submissionState: "not_sent",
    retryCount: 0,
    config: { providerId: 7 },
    ...overrides,
  } as unknown as HydratedGenerationTask;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stuckLeaseCutoff.mockReturnValue(LEASE_CUTOFF);
  mocks.getSetting.mockImplementation((key: string) => {
    if (key === "worker.max_retries") return 2;
    throw new Error(`unexpected getSetting(${key})`);
  });
  mocks.executeSubmissionPhase.mockResolvedValue(undefined);
  mocks.runPollAttempt.mockResolvedValue(undefined);
  mocks.safeFailTask.mockResolvedValue({ id: "task-1" });
});

describe("processTaskJob", () => {
  it("任务行不存在 → no-op", async () => {
    mocks.getTask.mockResolvedValue(null);
    await processTaskJob("task-1", new AbortController().signal, CTX);
    expect(mocks.claimPendingTask).not.toHaveBeenCalled();
  });

  it("终态行 → no-op，不认领不分派", async () => {
    mocks.getTask.mockResolvedValue(makeTask({ status: "failed" }));
    await processTaskJob("task-1", new AbortController().signal, CTX);
    expect(mocks.claimPendingTask).not.toHaveBeenCalled();
    expect(mocks.runPollAttempt).not.toHaveBeenCalled();
  });

  it("pending 无 upstreamTaskId → CAS 认领后进提交段", async () => {
    const claimed = makeTask({ status: "pending" });
    mocks.getTask.mockResolvedValue(makeTask({ status: "pending" }));
    mocks.claimPendingTask.mockResolvedValue(claimed);

    const signal = new AbortController().signal;
    await processTaskJob("task-1", signal, CTX);

    expect(mocks.claimPendingTask).toHaveBeenCalledWith("task-1");
    expect(mocks.executeSubmissionPhase).toHaveBeenCalledWith(claimed, signal, CTX);
    expect(mocks.runPollAttempt).not.toHaveBeenCalled();
  });

  it("pending 带 upstreamTaskId（轮询预算重入队恢复）→ 认领后进轮询段，绝不重提", async () => {
    const claimed = makeTask({ status: "pending", upstreamTaskId: "up-1" });
    mocks.getTask.mockResolvedValue(makeTask({ status: "pending", upstreamTaskId: "up-1" }));
    mocks.claimPendingTask.mockResolvedValue(claimed);

    await processTaskJob("task-1", new AbortController().signal, CTX);

    expect(mocks.executeSubmissionPhase).not.toHaveBeenCalled();
    expect(mocks.runPollAttempt).toHaveBeenCalledWith(claimed, expect.any(AbortSignal), CTX);
  });

  it("pending 认领失败（输给其他实例）→ no-op", async () => {
    mocks.getTask.mockResolvedValue(makeTask({ status: "pending" }));
    mocks.claimPendingTask.mockResolvedValue(null);

    await processTaskJob("task-1", new AbortController().signal, CTX);

    expect(mocks.executeSubmissionPhase).not.toHaveBeenCalled();
  });

  it("processing + 已受理 → 直接单次轮询尝试", async () => {
    const task = makeTask({ upstreamTaskId: "up-1" });
    mocks.getTask.mockResolvedValue(task);

    const signal = new AbortController().signal;
    await processTaskJob("task-1", signal, CTX);

    expect(mocks.runPollAttempt).toHaveBeenCalledWith(task, signal, CTX);
    expect(mocks.executeSubmissionPhase).not.toHaveBeenCalled();
  });

  it("processing + 未受理 + 租约新鲜（他实例执行者在途）→ 跳过", async () => {
    mocks.getTask.mockResolvedValue(makeTask({ updatedAt: new Date() }));

    await processTaskJob("task-1", new AbortController().signal, CTX);

    expect(mocks.executeSubmissionPhase).not.toHaveBeenCalled();
    expect(mocks.takeOverInterruptedTask).not.toHaveBeenCalled();
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("processing + 未受理 + in_flight 过期 → 判 submission_uncertain，绝不重发", async () => {
    mocks.getTask.mockResolvedValue(
      makeTask({ submissionState: "in_flight", updatedAt: STALE_UPDATED_AT() })
    );

    await processTaskJob("task-1", new AbortController().signal, CTX);

    expect(mocks.takeOverInterruptedTask).not.toHaveBeenCalled();
    expect(mocks.executeSubmissionPhase).not.toHaveBeenCalled();
    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ errorCode: "generation.submission_uncertain" }),
      { startedAt: STARTED_AT }
    );
  });

  it("processing + 未受理 + not_sent 过期 → 接管 CAS 后以新任务重进提交段", async () => {
    const taken = makeTask({ startedAt: new Date(), submissionState: "not_sent", updatedAt: new Date(), retryCount: 1 });
    mocks.getTask.mockResolvedValue(makeTask({ updatedAt: STALE_UPDATED_AT() }));
    mocks.takeOverInterruptedTask.mockResolvedValue({ kind: "taken", task: taken });

    const signal = new AbortController().signal;
    await processTaskJob("task-1", signal, CTX);

    expect(mocks.takeOverInterruptedTask).toHaveBeenCalledWith("task-1", LEASE_CUTOFF, 2);
    expect(mocks.executeSubmissionPhase).toHaveBeenCalledWith(taken, signal, CTX);
    expect(mocks.safeFailTask).not.toHaveBeenCalled();
  });

  it("接管返回预算耗尽 → 判失败 interrupted_retry_exhausted", async () => {
    mocks.getTask.mockResolvedValue(makeTask({ updatedAt: STALE_UPDATED_AT() }));
    mocks.takeOverInterruptedTask.mockResolvedValue({ kind: "budget_exhausted" });

    await processTaskJob("task-1", new AbortController().signal, CTX);

    expect(mocks.executeSubmissionPhase).not.toHaveBeenCalled();
    expect(mocks.safeFailTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ errorCode: "generation.interrupted_retry_exhausted" }),
      { startedAt: STARTED_AT }
    );
  });

  it("接管丢失（并发竞争）→ no-op 不写终态", async () => {
    mocks.getTask.mockResolvedValue(makeTask({ updatedAt: STALE_UPDATED_AT() }));
    mocks.takeOverInterruptedTask.mockResolvedValue({ kind: "lost" });

    await processTaskJob("task-1", new AbortController().signal, CTX);

    expect(mocks.safeFailTask).not.toHaveBeenCalled();
    expect(mocks.executeSubmissionPhase).not.toHaveBeenCalled();
  });
});
