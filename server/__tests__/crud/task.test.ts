/**
 * 任务 CRUD 原语测试（specs/task-queue-bullmq.md）。
 * 锁定各 CAS 原语的谓词与写入形态：单任务认领、受理落库（含首 tick）、
 * 提交闸门、中断接管（预算分类）、轮询 tick 落点、清扫候选窗口、
 * 心跳与轮询预算重入队。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  logEvent: vi.fn(),
  publishTaskTerminal: vi.fn(),
}));

vi.mock("@server/core/database/client", () => ({
  prisma: {
    generationTask: {
      updateMany: mocks.updateMany,
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
    },
  },
}));
vi.mock("@server/services/tasks/event-bus", () => ({
  publishTaskTerminal: mocks.publishTaskTerminal,
}));
vi.mock("@server/core/logger/utils", () => ({
  logEvent: mocks.logEvent,
  errText: (err: unknown) => String(err),
}));
vi.mock("@server/core/settings", async () =>
  (await import("../helpers/settings")).settingsModuleMock()
);

import {
  claimPendingTask,
  acceptUpstreamTask,
  takeSubmissionGate,
  takeOverInterruptedTask,
  deferPollTick,
  findReconcileCandidates,
  touchTaskHeartbeat,
  requeueProcessingAsyncTask,
  stuckLeaseCutoff,
} from "@server/crud/task";
import { resetTestSettings } from "../helpers/settings";

const STARTED_AT = new Date("2026-01-01T00:00:00.000Z");

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    userId: 1,
    type: "image",
    protocol: null,
    model: null,
    prompt: "p",
    config: '{"providerId":1}',
    refImages: null,
    refAudios: null,
    refVideos: null,
    resultUrls: "[]",
    resultText: null,
    error: null,
    errorCode: null,
    status: "processing",
    nodeId: "",
    upstreamTaskId: null,
    submissionState: "not_sent",
    nextPollAt: null,
    asyncPollAttempts: 0,
    retryCount: 0,
    startedAt: STARTED_AT,
    completedAt: null,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMany.mockResolvedValue({ count: 0 });
  mocks.findMany.mockResolvedValue([]);
  mocks.findUnique.mockResolvedValue(null);
});

describe("touchTaskHeartbeat", () => {
  it("守卫命中时返回所有权仍存在", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(touchTaskHeartbeat("task-1", STARTED_AT)).resolves.toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "processing", startedAt: STARTED_AT },
      data: { updatedAt: expect.any(Date) },
    });
  });

  it("守卫未命中时返回所有权丢失", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(touchTaskHeartbeat("task-1", STARTED_AT)).resolves.toBe(false);
  });

  it("数据库错误不误判为所有权丢失，记录日志后继续轮询", async () => {
    mocks.updateMany.mockRejectedValue(new Error("db unavailable"));

    await expect(touchTaskHeartbeat("task-1", STARTED_AT)).resolves.toBe(true);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      "task",
      expect.objectContaining({ stage: "heartbeat_write_failed", taskId: "task-1" }),
    );
  });
});

describe("claimPendingTask（单任务 CAS 认领）", () => {
  it("CAS 命中 → 写入 processing + 新 startedAt 令牌，复读返回含水合 config 的任务", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findUnique.mockResolvedValue(makeRow({ status: "processing", config: '{"providerId":1}' }));

    const claimed = await claimPendingTask("task-1");

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "pending" },
      data: { status: "processing", startedAt: expect.any(Date), updatedAt: expect.any(Date) },
    });
    expect(claimed).not.toBeNull();
    expect(claimed!.config).toEqual({ providerId: 1 });
  });

  it("CAS 未命中（已被他实例认领）→ null，不复读", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(claimPendingTask("task-1")).resolves.toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});

describe("acceptUpstreamTask（异步受理落库）", () => {
  const nextPollAt = new Date("2026-01-01T00:00:01.000Z");

  it("守卫命中 → 写入 upstreamTaskId + 首个 nextPollAt + 尝试计数归零", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(acceptUpstreamTask("task-1", "up-1", STARTED_AT, nextPollAt)).resolves.toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "processing", startedAt: STARTED_AT },
      data: {
        upstreamTaskId: "up-1",
        nextPollAt,
        asyncPollAttempts: 0,
        updatedAt: expect.any(Date),
      },
    });
  });

  it("守卫未命中（已取消/重置/重新认领）→ 写入被丢弃，返回 false", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(acceptUpstreamTask("task-1", "up-1", STARTED_AT, nextPollAt)).resolves.toBe(false);
  });
});

describe("takeSubmissionGate（提交闸门）", () => {
  it("命中 → not_sent 置 in_flight，谓词含所有权令牌与闸门状态", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(takeSubmissionGate("task-1", STARTED_AT)).resolves.toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "task-1",
        status: "processing",
        startedAt: STARTED_AT,
        submissionState: "not_sent",
      },
      data: { submissionState: "in_flight", updatedAt: expect.any(Date) },
    });
  });

  it("未命中（已失权或闸门已被占）→ false", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(takeSubmissionGate("task-1", STARTED_AT)).resolves.toBe(false);
  });
});

describe("takeOverInterruptedTask（中断接管 CAS）", () => {
  const leaseCutoff = new Date("2026-01-01T00:15:00.000Z");

  it("CAS 命中 → 新令牌 + retryCount+1，复读返回 taken 与任务", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findUnique.mockResolvedValue(makeRow({ retryCount: 1 }));

    const result = await takeOverInterruptedTask("task-1", leaseCutoff, 2);

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "task-1",
        status: "processing",
        submissionState: "not_sent",
        updatedAt: { lt: leaseCutoff },
        retryCount: { lt: 2 },
      },
      data: { startedAt: expect.any(Date), retryCount: { increment: 1 }, updatedAt: expect.any(Date) },
    });
    expect(result).toMatchObject({ kind: "taken", task: { id: "task-1", retryCount: 1 } });
  });

  it("CAS 未命中且复读确认预算烧完 → budget_exhausted", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.findUnique.mockResolvedValue(
      makeRow({ submissionState: "not_sent", updatedAt: new Date("2026-01-01T00:00:00.000Z"), retryCount: 2 })
    );

    await expect(takeOverInterruptedTask("task-1", leaseCutoff, 2)).resolves.toEqual({
      kind: "budget_exhausted",
    });
  });

  it("CAS 未命中且复读发现行已被他方改动 → lost", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.findUnique.mockResolvedValue(makeRow({ status: "pending" }));

    await expect(takeOverInterruptedTask("task-1", leaseCutoff, 2)).resolves.toEqual({ kind: "lost" });
  });
});

describe("deferPollTick（轮询 tick 落点）", () => {
  const nextPollAt = new Date("2026-01-01T00:00:03.000Z");

  it("命中 → 写入 nextPollAt 与累计尝试数", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(deferPollTick("task-1", STARTED_AT, nextPollAt, 7)).resolves.toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "processing", startedAt: STARTED_AT },
      data: { nextPollAt, asyncPollAttempts: 7, updatedAt: expect.any(Date) },
    });
  });

  it("未命中（失权执行者迟写）→ false，调用方不调度下一次 tick", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(deferPollTick("task-1", STARTED_AT, nextPollAt, 7)).resolves.toBe(false);
  });
});

describe("findReconcileCandidates（清扫候选窗口）", () => {
  const pendingCutoff = new Date("2026-01-01T00:01:00.000Z");
  const leaseCutoff = new Date("2026-01-01T00:15:00.000Z");
  const now = new Date("2026-01-01T00:20:00.000Z");

  it("三类窗口分别查询并映射 ID", async () => {
    mocks.findMany
      .mockResolvedValueOnce([{ id: "p-1" }])
      .mockResolvedValueOnce([{ id: "e-1" }])
      .mockResolvedValueOnce([{ id: "o-1" }]);

    const result = await findReconcileCandidates(pendingCutoff, leaseCutoff, now);

    expect(result).toEqual({
      pendingStaleIds: ["p-1"],
      executionExpiredIds: ["e-1"],
      pollOverdueIds: ["o-1"],
    });
    const [pendingWhere, leaseWhere, pollWhere] = mocks.findMany.mock.calls.map(
      (c) => (c[0] as { where: Record<string, unknown> }).where
    );
    expect(pendingWhere).toEqual({ status: "pending", updatedAt: { lt: pendingCutoff } });
    expect(leaseWhere).toEqual({
      status: "processing",
      upstreamTaskId: null,
      updatedAt: { lt: leaseCutoff },
    });
    expect(pollWhere).toEqual({
      status: "processing",
      upstreamTaskId: { not: null },
      OR: [{ nextPollAt: { lte: now } }, { nextPollAt: null }],
    });
  });
});

describe("stuckLeaseCutoff（租约截止统一口径）", () => {
  it("= 当前时刻 - stuck_timeout_minutes（handler 接管/判失败与清扫共用同一实现）", () => {
    resetTestSettings({ "worker.stuck_timeout_minutes": 15 });
    const before = Date.now();
    const cutoff = stuckLeaseCutoff();
    const after = Date.now();
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 15 * 60_000 - 100);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - 15 * 60_000 + 100);
  });

  it("显式传入 now 时按该时刻换算（清扫携带扫描时刻调用）", () => {
    resetTestSettings({ "worker.stuck_timeout_minutes": 15 });
    const now = new Date("2026-01-01T12:00:00.000Z");
    expect(stuckLeaseCutoff(now).getTime()).toBe(now.getTime() - 15 * 60_000);
  });
});

describe("requeueProcessingAsyncTask（轮询预算耗尽重入队）", () => {
  it("守卫命中 → 重置 pending 且 retryCount+1、轮询计数归零，返回 true", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(requeueProcessingAsyncTask("task-1", STARTED_AT, 2)).resolves.toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "task-1",
        status: "processing",
        startedAt: STARTED_AT,
        retryCount: { lt: 2 },
      },
      data: {
        status: "pending",
        error: null,
        retryCount: { increment: 1 },
        asyncPollAttempts: 0,
        updatedAt: expect.any(Date),
      },
    });
  });

  it("retryCount 预算烧完或所有权丢失（守卫未命中）→ 返回 false", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(requeueProcessingAsyncTask("task-1", STARTED_AT, 2)).resolves.toBe(false);
  });
});
