/**
 * 队列适配层测试（specs/task-queue-bullmq.md 规则 2/7/8）：
 * 重激活原语的状态分派（live job 跳过、终态残留先移除再入队）、
 * 取消路由的尽力移除、健康上报与启动探测。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const queueInstance = {
    getJob: vi.fn(),
    add: vi.fn(),
    getJobCounts: vi.fn(),
    close: vi.fn(),
  };
  const connInstance = {
    ping: vi.fn(),
    on: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    queueInstance,
    connInstance,
    logEvent: vi.fn(),
    Queue: vi.fn(() => queueInstance),
    IORedis: vi.fn(() => connInstance),
  };
});

// Queue 打桩，DelayedError 等其余导出透传真实实现（自调度原语的异常类型须一致）
vi.mock("bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bullmq")>();
  return { ...actual, Queue: mocks.Queue };
});
vi.mock("ioredis", () => ({ default: mocks.IORedis }));
vi.mock("@server/core/config", () => ({ getConfig: () => ({ REDIS_URL: "redis://localhost:6399" }) }));
vi.mock("@server/core/logger", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock("@server/core/logger/utils", () => ({
  logEvent: mocks.logEvent,
  errText: (e: unknown) => String(e),
}));

import { DelayedError } from "bullmq";
import {
  initTaskQueue,
  reactivateTask,
  reactivateBestEffort,
  deferActiveTickOrThrow,
  cancelQueuedTask,
  getQueueHealth,
  TASK_QUEUE_NAME,
  TASK_QUEUE_PREFIX,
} from "@server/services/worker/queue";

/** job stub：state + remove 行为可注入 */
function makeJob(state: string, remove: () => Promise<void> = async () => {}) {
  return { getState: vi.fn(async () => state), remove: vi.fn(remove) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queueInstance.add.mockResolvedValue({});
  mocks.queueInstance.getJobCounts.mockResolvedValue({ waiting: 0, delayed: 0, active: 0 });
});

describe("initTaskQueue", () => {
  it("PING 返回 PONG → 探测通过，并以专用前缀与默认 job 选项构建队列单例", async () => {
    mocks.connInstance.ping.mockResolvedValue("PONG");
    await expect(initTaskQueue()).resolves.toBeUndefined();
    expect(mocks.IORedis).toHaveBeenCalledWith("redis://localhost:6399", { maxRetriesPerRequest: null });
    expect(mocks.Queue).toHaveBeenCalledWith(
      TASK_QUEUE_NAME,
      expect.objectContaining({
        prefix: TASK_QUEUE_PREFIX,
        defaultJobOptions: expect.objectContaining({ attempts: 3 }),
      })
    );
    expect(TASK_QUEUE_PREFIX).toMatch(/:$/);
  });

  it("PING 非 PONG → 启动失败（规则 7）", async () => {
    mocks.connInstance.ping.mockResolvedValue("PONG2");
    await expect(initTaskQueue()).rejects.toThrow("unexpected reply");
  });

  it("PING 抛错（不可达）→ 启动失败", async () => {
    mocks.connInstance.ping.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(initTaskQueue()).rejects.toThrow("ECONNREFUSED");
  });
});

describe("reactivateTask", () => {
  it("无既有 job → add dispatch（jobId = taskId）", async () => {
    mocks.queueInstance.getJob.mockResolvedValue(null);

    await expect(reactivateTask("t-1")).resolves.toBe("added");

    expect(mocks.queueInstance.add).toHaveBeenCalledWith(
      "dispatch",
      { taskId: "t-1" },
      { jobId: "t-1" }
    );
  });

  it("job 存活（waiting/delayed/active）→ skipped，不 remove 不 add（幂等核心）", async () => {
    for (const state of ["waiting", "delayed", "active"]) {
      const job = makeJob(state);
      mocks.queueInstance.getJob.mockResolvedValue(job);

      await expect(reactivateTask("t-1")).resolves.toBe("skipped");

      expect(job.remove).not.toHaveBeenCalled();
    }
    expect(mocks.queueInstance.add).not.toHaveBeenCalled();
  });

  it("终态残留（completed/failed，保留窗口内仍占 jobId）→ 先移除再入队", async () => {
    for (const state of ["completed", "failed"]) {
      const job = makeJob(state);
      mocks.queueInstance.getJob.mockResolvedValue(job);

      await expect(reactivateTask("t-1")).resolves.toBe("added");

      expect(job.remove).toHaveBeenCalledTimes(1);
      expect(mocks.queueInstance.add).toHaveBeenLastCalledWith(
        "dispatch",
        { taskId: "t-1" },
        { jobId: "t-1" }
      );
    }
  });
});

describe("reactivateBestEffort", () => {
  it("成功 → 结果透传，不记告警日志", async () => {
    mocks.queueInstance.getJob.mockResolvedValue(null);

    await expect(
      reactivateBestEffort("t-1", { channel: "http.generate", stage: "enqueue_failed" })
    ).resolves.toBe("added");

    expect(mocks.queueInstance.add).toHaveBeenCalledWith(
      "dispatch",
      { taskId: "t-1" },
      { jobId: "t-1" }
    );
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("底层抛错 → 记 warn 日志并返回 null，不向调用方抛（自愈语义单源）", async () => {
    mocks.queueInstance.getJob.mockRejectedValue(new Error("redis down"));

    await expect(
      reactivateBestEffort("t-1", {
        channel: "executor",
        stage: "async_dispatch_schedule_failed",
      })
    ).resolves.toBeNull();

    expect(mocks.logEvent).toHaveBeenCalledWith(
      "executor",
      expect.objectContaining({
        level: "warn",
        stage: "async_dispatch_schedule_failed",
        taskId: "t-1",
      })
    );
  });
});

describe("deferActiveTickOrThrow", () => {
  it("moveToDelayed 成功 → 记 tick_deferred 并抛 DelayedError（worker 据此跳过 finalize）", async () => {
    const job = { moveToDelayed: vi.fn().mockResolvedValue(undefined) };

    await expect(
      deferActiveTickOrThrow({ job: job as never, token: "tok" }, "t-1", new Date(1700000000000))
    ).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(1700000000000, "tok");
    expect(mocks.logEvent).toHaveBeenCalledWith(
      "queue",
      expect.objectContaining({ stage: "tick_deferred", taskId: "t-1" })
    );
  });

  it("moveToDelayed 失败（锁丢失/Redis 抖动）→ 记 warn 正常返回，不抛（清扫自愈）", async () => {
    const job = { moveToDelayed: vi.fn().mockRejectedValue(new Error("lock lost")) };

    await expect(
      deferActiveTickOrThrow({ job: job as never, token: "tok" }, "t-1", new Date())
    ).resolves.toBeUndefined();

    expect(mocks.logEvent).toHaveBeenCalledWith(
      "queue",
      expect.objectContaining({ level: "warn", stage: "tick_defer_failed", taskId: "t-1" })
    );
  });
});

describe("cancelQueuedTask", () => {
  it("waiting / delayed job → 尽力移除", async () => {
    for (const state of ["waiting", "delayed"]) {
      const job = makeJob(state);
      mocks.queueInstance.getJob.mockResolvedValue(job);

      await cancelQueuedTask("t-1");

      expect(job.remove).toHaveBeenCalledTimes(1);
    }
  });

  it("active / completed job → 不动（active remove 语义不可靠，终态天然无需移除）", async () => {
    for (const state of ["active", "completed", "failed"]) {
      const job = makeJob(state);
      mocks.queueInstance.getJob.mockResolvedValue(job);

      await cancelQueuedTask("t-1");

      expect(job.remove).not.toHaveBeenCalled();
    }
  });

  it("队列操作异常 → 吞掉不抛（handler 终态 no-op 兜底）", async () => {
    mocks.queueInstance.getJob.mockRejectedValue(new Error("redis down"));
    await expect(cancelQueuedTask("t-1")).resolves.toBeUndefined();
  });
});

describe("getQueueHealth", () => {
  it("redis 可达 → 单条命令取三个状态计数并汇总", async () => {
    mocks.queueInstance.getJobCounts.mockResolvedValue({ waiting: 1, delayed: 2, active: 3 });

    await expect(getQueueHealth()).resolves.toEqual({ redis: true, queueDepth: 6 });

    expect(mocks.queueInstance.getJobCounts).toHaveBeenCalledWith("waiting", "delayed", "active");
  });

  it("redis 异常 → 降级上报 redis=false / queueDepth=null", async () => {
    mocks.queueInstance.getJobCounts.mockRejectedValue(new Error("redis down"));

    await expect(getQueueHealth()).resolves.toEqual({ redis: false, queueDepth: null });
  });

  it("读数未结算时并发调用共用同一条命令，结算后都拿到结果", async () => {
    let settle: (counts: Record<string, number>) => void = () => {};
    mocks.queueInstance.getJobCounts.mockImplementationOnce(
      () => new Promise((resolve) => {
        settle = resolve;
      })
    );

    const first = getQueueHealth();
    const second = getQueueHealth();
    expect(mocks.queueInstance.getJobCounts).toHaveBeenCalledTimes(1);

    settle({ waiting: 0, delayed: 0, active: 0 });
    await expect(first).resolves.toEqual({ redis: true, queueDepth: 0 });
    await expect(second).resolves.toEqual({ redis: true, queueDepth: 0 });
    expect(mocks.queueInstance.getJobCounts).toHaveBeenCalledTimes(1);

    // 结算后闸门放开：下一次读数重新取数
    await expect(getQueueHealth()).resolves.toEqual({ redis: true, queueDepth: 0 });
    expect(mocks.queueInstance.getJobCounts).toHaveBeenCalledTimes(2);
  });

  it("读数超时不影响闸门：底层命令仍在路上时不发新命令（半开连接下不堆积）", async () => {
    vi.useFakeTimers();
    try {
      let settle: (counts: Record<string, number>) => void = () => {};
      mocks.queueInstance.getJobCounts.mockImplementationOnce(
        () => new Promise((resolve) => {
          settle = resolve;
        })
      );

      const first = getQueueHealth();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(first).resolves.toEqual({ redis: false, queueDepth: null });

      const second = getQueueHealth();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(second).resolves.toEqual({ redis: false, queueDepth: null });
      expect(mocks.queueInstance.getJobCounts).toHaveBeenCalledTimes(1);

      settle({ waiting: 0, delayed: 0, active: 0 });
      await vi.advanceTimersByTimeAsync(0);
      await expect(getQueueHealth()).resolves.toEqual({ redis: true, queueDepth: 0 });
      expect(mocks.queueInstance.getJobCounts).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
