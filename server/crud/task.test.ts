import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findMany: vi.fn(),
  logEvent: vi.fn(),
  publishTaskTerminal: vi.fn(),
}));

vi.mock("@server/core/database/client", () => ({
  prisma: {
    generationTask: {
      updateMany: mocks.updateMany,
      findMany: mocks.findMany,
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

import {
  cleanupZombieTasks,
  recoverProcessingTasks,
  touchTaskHeartbeat,
  requeueProcessingAsyncTask,
} from "./task";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMany.mockResolvedValue({ count: 0 });
  mocks.findMany.mockResolvedValue([]);
});

describe("touchTaskHeartbeat", () => {
  const startedAt = new Date("2026-01-01T00:00:00.000Z");

  it("守卫命中时返回所有权仍存在", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(touchTaskHeartbeat("task-1", startedAt)).resolves.toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "processing", startedAt },
      data: { updatedAt: expect.any(Date) },
    });
  });

  it("守卫未命中时返回所有权丢失", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(touchTaskHeartbeat("task-1", startedAt)).resolves.toBe(false);
  });

  it("数据库错误不误判为所有权丢失，记录日志后继续轮询", async () => {
    mocks.updateMany.mockRejectedValue(new Error("db unavailable"));

    await expect(touchTaskHeartbeat("task-1", startedAt)).resolves.toBe(true);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      "task",
      expect.objectContaining({ stage: "heartbeat_write_failed", taskId: "task-1" }),
    );
  });
});

describe("requeueProcessingAsyncTask（M7：轮询预算耗尽重入队）", () => {
  const startedAt = new Date("2026-01-01T00:00:00.000Z");

  it("守卫命中 → 重置 pending 且 retryCount+1，返回 true", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(requeueProcessingAsyncTask("task-1", startedAt, 2)).resolves.toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: {
        id: "task-1",
        status: "processing",
        startedAt,
        retryCount: { lt: 2 },
      },
      data: {
        status: "pending",
        error: null,
        retryCount: { increment: 1 },
        updatedAt: expect.any(Date),
      },
    });
  });

  it("retryCount 预算烧完或所有权丢失（守卫未命中）→ 返回 false", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(requeueProcessingAsyncTask("task-1", startedAt, 2)).resolves.toBe(false);
  });
});

describe("cleanupZombieTasks（M6：中断的同步任务不重新提交）", () => {
  it("同步僵尸（无 upstreamTaskId）→ 直接终态 failed，不重置重跑", async () => {
    // 死分支候选为空；中断分支先取候选 ID 再写入（与死分支同模式）
    mocks.findMany
      .mockResolvedValueOnce([]) // 死分支候选
      .mockResolvedValueOnce([{ id: "sync-1" }]) // 中断分支候选
      .mockResolvedValueOnce([]); // 广播读回（本用例不断言广播）
    mocks.updateMany
      .mockResolvedValueOnce({ count: 0 }) // retried（异步重置）
      .mockResolvedValueOnce({ count: 1 }); // interrupted（同步判失败）

    const cleaned = await cleanupZombieTasks(15, 2);
    expect(cleaned).toBe(1);

    // 两次写入的谓词按 upstreamTaskId 分流
    const [retriedCall, interruptedCall] = mocks.updateMany.mock.calls.map(
      (c) => c[0] as { where: Record<string, unknown>; data: Record<string, unknown> }
    );
    expect(retriedCall.where).toMatchObject({
      status: "processing",
      retryCount: { lt: 2 },
      upstreamTaskId: { not: null },
    });
    expect(interruptedCall.where).toMatchObject({
      status: "processing",
      upstreamTaskId: null,
    });
    // 同步僵尸：终态 failed + 专用错误码，completedAt 落库，绝不重置 pending。
    // 谓词不设 retryCount 条款——同步任务无论重试预算如何一律不重提上游
    expect(interruptedCall.data).toMatchObject({
      status: "failed",
      errorCode: "generation.interrupted_no_resubmit",
      error: expect.stringContaining("放弃重试"),
      completedAt: expect.any(Date),
    });
  });

  it("异步僵尸（有 upstreamTaskId）→ 保持重置 pending + retryCount 递增", async () => {
    // 死分支候选与中断分支候选均为空（findMany 缺省 []，对应写入被跳过；
    // 不得预置多余的 Once 返回值——Once 队列泄漏会污染后续用例的调用序）
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }); // retried

    const cleaned = await cleanupZombieTasks(15, 2);
    expect(cleaned).toBe(1);

    const retriedCall = mocks.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(retriedCall.where).toMatchObject({ upstreamTaskId: { not: null } });
    expect(retriedCall.data).toMatchObject({
      status: "pending",
      error: null,
      retryCount: { increment: 1 },
    });
  });

  it("超限僵尸直接判死，广播只覆盖真正被本次写入判死的行", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }); // 判死写入
    mocks.findMany
      .mockResolvedValueOnce([{ id: "dead-1" }]) // 死分支候选
      .mockResolvedValueOnce([
        // 判死行的终态投影（广播）
        {
          id: "dead-1",
          status: "failed",
          resultUrls: "[]",
          resultText: null,
          error: "Task stuck (zombie cleanup, exceeded max retries)",
          errorCode: "generation.zombie_timeout",
          prompt: "p",
          config: "{}",
          userId: 1,
        },
      ]);

    const cleaned = await cleanupZombieTasks(15, 2);
    expect(cleaned).toBe(1);

    const deadCall = mocks.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(deadCall.where).toMatchObject({
      status: "processing",
      retryCount: { gte: 2 },
    });
    expect(deadCall.data).toMatchObject({
      status: "failed",
      errorCode: "generation.zombie_timeout",
    });
    expect(mocks.publishTaskTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "dead-1", status: "failed" })
    );
  });

  it("中断分支广播终态，前台立即收到失败事件", async () => {
    mocks.updateMany
      .mockResolvedValueOnce({ count: 0 }) // retried
      .mockResolvedValueOnce({ count: 1 }); // interrupted
    // 死分支候选为空；中断分支：候选 ID → 写入 → 按 ID + status 读回广播
    mocks.findMany
      .mockResolvedValueOnce([]) // 死分支候选
      .mockResolvedValueOnce([{ id: "sync-1" }]) // 中断分支候选
      .mockResolvedValueOnce([
        {
          id: "sync-1",
          status: "failed",
          resultUrls: "[]",
          resultText: null,
          error: "任务执行中断，为避免重复提交上游已放弃重试",
          errorCode: "generation.interrupted_no_resubmit",
          prompt: "p",
          config: "{}",
          userId: 1,
        },
      ]);

    await cleanupZombieTasks(15, 2);

    expect(mocks.publishTaskTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "sync-1",
        status: "failed",
        errorCode: "generation.interrupted_no_resubmit",
      })
    );
  });
});

describe("recoverProcessingTasks（M6：重启后同步任务不再重新提交）", () => {
  const baseRow = {
    id: "t-1",
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
    retryCount: 0,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("同步任务（无 upstreamTaskId）→ 直接终态 failed，不计入恢复列表", async () => {
    mocks.findMany.mockResolvedValue([
      { ...baseRow, id: "sync-1", upstreamTaskId: null },
    ]);

    const { interrupted, asyncTasks } = await recoverProcessingTasks();

    expect(interrupted).toBe(1);
    expect(asyncTasks).toHaveLength(0);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["sync-1"] } },
      data: expect.objectContaining({
        status: "failed",
        errorCode: "generation.interrupted_no_resubmit",
        completedAt: expect.any(Date),
      }),
    });
  });

  it("异步任务（有 upstreamTaskId）→ 保持 processing 交恢复轮询，不写终态", async () => {
    mocks.findMany.mockResolvedValue([
      { ...baseRow, id: "async-1", upstreamTaskId: "up-1" },
    ]);

    const { interrupted, asyncTasks } = await recoverProcessingTasks();

    expect(interrupted).toBe(0);
    expect(asyncTasks).toHaveLength(1);
    expect(asyncTasks[0]).toMatchObject({ id: "async-1", upstreamTaskId: "up-1" });
    // JSON 列已反序列化
    expect(asyncTasks[0]!.config).toEqual({ providerId: 1 });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
