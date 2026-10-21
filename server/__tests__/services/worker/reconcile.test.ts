/**
 * 对账清扫测试（specs/task-queue-bullmq.md 规则 7 安全网）：
 * 候选窗口参数传递、逐行重激活幂等容错（单行失败不阻断本轮）、防重入。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findReconcileCandidates: vi.fn(),
  stuckLeaseCutoff: vi.fn(),
  reactivateTask: vi.fn(),
  getSetting: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@server/crud/task", () => ({
  findReconcileCandidates: mocks.findReconcileCandidates,
  stuckLeaseCutoff: mocks.stuckLeaseCutoff,
}));
vi.mock("@server/services/worker/queue", () => ({ reactivateTask: mocks.reactivateTask }));
vi.mock("@server/core/settings", () => ({ getSetting: mocks.getSetting }));
vi.mock("@server/core/logger/utils", () => ({
  logEvent: mocks.logEvent,
  errText: (e: unknown) => String(e),
}));

import { reconcileSweep } from "@server/services/worker/reconcile";

/** 租约截止 stub：固定值使窗口断言只针对 pending 窗口（时钟漂移面缩小一半） */
const LEASE_CUTOFF = new Date("2026-01-01T10:45:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stuckLeaseCutoff.mockReturnValue(LEASE_CUTOFF);
  mocks.getSetting.mockImplementation((key: string) => {
    if (key === "worker.zombie_scan_interval_seconds") return 60;
    throw new Error(`unexpected getSetting(${key})`);
  });
  mocks.reactivateTask.mockResolvedValue("added");
  mocks.findReconcileCandidates.mockResolvedValue({
    pendingStaleIds: [],
    executionExpiredIds: [],
    pollOverdueIds: [],
  });
});

describe("reconcileSweep", () => {
  it("无候选 → 不触发任何重激活", async () => {
    await reconcileSweep();
    expect(mocks.reactivateTask).not.toHaveBeenCalled();
  });

  it("三类候选（pending 逾期 / 执行段租约过期 / 轮询 tick 逾期）逐行重激活", async () => {
    mocks.findReconcileCandidates.mockResolvedValue({
      pendingStaleIds: ["p-1"],
      executionExpiredIds: ["e-1"],
      pollOverdueIds: ["o-1", "o-2"],
    });

    await reconcileSweep();

    expect(mocks.reactivateTask).toHaveBeenCalledTimes(4);
    for (const id of ["p-1", "e-1", "o-1", "o-2"]) {
      expect(mocks.reactivateTask).toHaveBeenCalledWith(id);
    }
  });

  it("窗口参数：pending 心跳窗口 = 清扫间隔，租约窗口 = stuck 阈值", async () => {
    mocks.findReconcileCandidates.mockResolvedValue({
      pendingStaleIds: [],
      executionExpiredIds: [],
      pollOverdueIds: [],
    });
    const before = Date.now();

    await reconcileSweep();

    // pending 截止 = 调用时刻往回退清扫间隔（± 100ms 时钟漂移余量）；
    // 租约截止 = crud 层 stuckLeaseCutoff 的返回值（窗口换算单源，此处只验透传）
    const [pendingCutoff, leaseCutoff] = mocks.findReconcileCandidates.mock.calls[0];
    expect(pendingCutoff.getTime()).toBeGreaterThanOrEqual(before - 60_000 - 100);
    expect(pendingCutoff.getTime()).toBeLessThanOrEqual(before - 60_000 + 100);
    expect(leaseCutoff).toBe(LEASE_CUTOFF);
  });

  it("单行重激活失败不阻断本轮，其余候选照常处理", async () => {
    mocks.findReconcileCandidates.mockResolvedValue({
      pendingStaleIds: ["p-1", "p-2"],
      executionExpiredIds: [],
      pollOverdueIds: [],
    });
    mocks.reactivateTask.mockImplementation(async (id: string) => {
      if (id === "p-1") throw new Error("redis down");
      return "added";
    });

    await expect(reconcileSweep()).resolves.toBeUndefined();

    expect(mocks.reactivateTask).toHaveBeenCalledWith("p-2");
  });

  it("防重入：上一轮未结束前的新调用直接跳过", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mocks.findReconcileCandidates.mockImplementation(async () => {
      await gate;
      return { pendingStaleIds: ["p-1"], executionExpiredIds: [], pollOverdueIds: [] };
    });

    const first = reconcileSweep();
    const second = reconcileSweep();
    release();
    await Promise.all([first, second]);

    // 第二次调用被跳过：DB 查询只执行了一次
    expect(mocks.findReconcileCandidates).toHaveBeenCalledTimes(1);
  });
});
