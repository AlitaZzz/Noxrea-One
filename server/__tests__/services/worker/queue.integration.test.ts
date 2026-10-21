/**
 * 队列适配层真 Redis 集成测试（specs/task-queue-bullmq.md 规则 2/6）。
 * 隔离策略（spec 范围 5）：TEST_REDIS_URL 指向专用 DB index（如 /15）实现键隔离，
 * 生产代码零改动；清理只删除本前缀键，禁止对共享实例 flushdb。
 * 未设置 TEST_REDIS_URL 时整组跳过（常规单测不依赖外部 Redis）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import IORedis from "ioredis";
import { Worker, DelayedError } from "bullmq";

const TEST_REDIS_URL = vi.hoisted(() => process.env.TEST_REDIS_URL ?? "redis://invalid");

// 仅替换 REDIS_URL；logger 等同链路消费方读取的其余字段保留真实默认
vi.mock("@server/core/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@server/core/config")>();
  return {
    ...actual,
    getConfig: () => ({ ...actual.getConfig(), REDIS_URL: TEST_REDIS_URL }),
  };
});

import {
  initTaskQueue,
  closeTaskQueue,
  reactivateTask,
  cancelQueuedTask,
  getQueueHealth,
  createQueueConnection,
  TASK_QUEUE_NAME,
  TASK_QUEUE_PREFIX,
} from "@server/services/worker/queue";

/** 轮询等待状态迁移（真 Redis 异步窗口），超时失败并输出最后观测值 */
async function waitForState(
  observe: () => Promise<string | null>,
  want: string | null,
  desc: string,
  timeoutMs = 8000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await observe();
    if (last === want) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitForState(${desc}): 期望 ${want}，超时前最后观测 ${last}`);
}

describe.skipIf(!process.env.TEST_REDIS_URL)("queue integration（真 Redis）", () => {
  /** 专用 DB index 的管理连接：用例间清理与最终清理共用（禁止对共享实例 flushdb） */
  let admin: IORedis;

  beforeAll(() => {
    admin = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  });

  /** 用例间清理：DB index 专用 + 前缀限定，前置用例遗留 job 不干扰后续 worker 用例 */
  beforeEach(async () => {
    let cursor = "0";
    do {
      const [next, keys] = await admin.scan(cursor, "MATCH", `${TASK_QUEUE_PREFIX}*`, "COUNT", 200);
      cursor = next;
      if (keys.length > 0) await admin.del(...keys);
    } while (cursor !== "0");
  });

  it("initTaskQueue：PING 探测通过，健康上报 redis=true", async () => {
    await expect(initTaskQueue()).resolves.toBeUndefined();
    await expect(getQueueHealth()).resolves.toEqual(expect.objectContaining({ redis: true }));
  }, 15000);

  it("reactivateTask：无 job → added 且 job 进入 waiting", async () => {
    await expect(reactivateTask("it-add-1")).resolves.toBe("added");
    const q = (await import("@server/services/worker/queue")).getTaskQueue();
    await waitForState(
      async () => (await q.getJob("it-add-1"))?.getState() ?? null,
      "waiting",
      "it-add-1 waiting"
    );
  }, 15000);

  it("reactivateTask：job 存活（waiting/delayed）→ skipped 幂等", async () => {
    await expect(reactivateTask("it-skip-1")).resolves.toBe("added");
    await expect(reactivateTask("it-skip-1")).resolves.toBe("skipped");

    // delayed 侧造数用队列原生 add：delayed 入队已无生产入口（自调度走
    // deferActiveTickOrThrow），验证重激活原语对 delayed 的幂等跳过
    const q = (await import("@server/services/worker/queue")).getTaskQueue();
    await q.add("dispatch", { taskId: "it-skip-2" }, { jobId: "it-skip-2", delay: 60000 });
    await expect(reactivateTask("it-skip-2")).resolves.toBe("skipped");
  }, 15000);

  it("getQueueHealth：新增 2 waiting + 1 delayed → 深度增量 = 3", async () => {
    const before = await getQueueHealth();
    await reactivateTask("it-depth-1");
    await reactivateTask("it-depth-2");
    // delayed 造数用队列原生 add（delayed 入队已无生产入口）
    const q = (await import("@server/services/worker/queue")).getTaskQueue();
    await q.add("dispatch", { taskId: "it-depth-3" }, { jobId: "it-depth-3", delay: 60000 });
    const after = await getQueueHealth();

    expect(after.redis).toBe(true);
    expect(after.queueDepth! - before.queueDepth!).toBe(3);
  }, 15000);

  it("cancelQueuedTask：waiting / delayed job 尽力移除，getJob 返回 undefined（BullMQ 未命中语义）", async () => {
    await reactivateTask("it-cancel-w");
    await cancelQueuedTask("it-cancel-w");
    const q = (await import("@server/services/worker/queue")).getTaskQueue();
    await expect(q.getJob("it-cancel-w")).resolves.toBeUndefined();

    // delayed 造数用队列原生 add（delayed 入队已无生产入口）
    await q.add("dispatch", { taskId: "it-cancel-d" }, { jobId: "it-cancel-d", delay: 60000 });
    await cancelQueuedTask("it-cancel-d");
    await expect(q.getJob("it-cancel-d")).resolves.toBeUndefined();
  }, 15000);

  it("cancelQueuedTask：active job 不动（语义不可靠，handler 终态 no-op 兜底）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const conn = createQueueConnection();
    const worker = new Worker(
      TASK_QUEUE_NAME,
      async () => {
        await gate;
      },
      { connection: conn, prefix: TASK_QUEUE_PREFIX, concurrency: 1 }
    );
    try {
      await reactivateTask("it-active-1");
      const q = (await import("@server/services/worker/queue")).getTaskQueue();
      await waitForState(
        async () => (await q.getJob("it-active-1"))?.getState() ?? null,
        "active",
        "it-active-1 active"
      );

      await cancelQueuedTask("it-active-1");

      const job = await q.getJob("it-active-1");
      expect(job).not.toBeNull();
      await expect(job!.getState()).resolves.toBe("active");
    } finally {
      release();
      await worker.close();
      conn.disconnect();
    }
  }, 20000);

  it("reactivateTask：终态残留（completed，保留窗口内占 jobId）→ remove 后重新入队", async () => {
    const conn = createQueueConnection();
    const worker = new Worker(TASK_QUEUE_NAME, async () => {}, {
      connection: conn,
      prefix: TASK_QUEUE_PREFIX,
      concurrency: 1,
    });
    try {
      await reactivateTask("it-residue-1");
      const q = (await import("@server/services/worker/queue")).getTaskQueue();
      await waitForState(
        async () => (await q.getJob("it-residue-1"))?.getState() ?? null,
        "completed",
        "it-residue-1 completed"
      );

      // completed 残留占着 jobId：隐式 add 幂等不可作为重入队依据，必须 remove + add
      await expect(reactivateTask("it-residue-1")).resolves.toBe("added");
    } finally {
      await worker.close();
      conn.disconnect();
    }
  }, 20000);

  it("processor 内自调度（规则 2 回写）：moveToDelayed + DelayedError → job 延迟后重跑至完成", async () => {
    // 验证 BullMQ 文档形态在真 Redis 上成立：active → delayed →（提升）→ active → completed
    const conn = createQueueConnection();
    let runs = 0;
    const worker = new Worker(
      TASK_QUEUE_NAME,
      async (job, token) => {
        runs += 1;
        if (runs === 1) {
          await job.moveToDelayed(Date.now() + 400, token);
          throw new DelayedError();
        }
      },
      { connection: conn, prefix: TASK_QUEUE_PREFIX, concurrency: 1 }
    );
    try {
      await reactivateTask("it-selfdefer-1");
      const q = (await import("@server/services/worker/queue")).getTaskQueue();
      await waitForState(
        async () => (await q.getJob("it-selfdefer-1"))?.getState() ?? null,
        "completed",
        "it-selfdefer-1 completed after self-defer rerun"
      );
      expect(runs).toBe(2);
    } finally {
      await worker.close();
      conn.disconnect();
    }
  }, 20000);

  it("强杀 worker（连接即断，锁未释放）→ stalled 检测接管后重跑完成（验收 3 机制层）", async () => {
    const connA = createQueueConnection();
    const workerA = new Worker(
      TASK_QUEUE_NAME,
      async () => {
        await new Promise(() => {}); // 模拟长在途：永不主动结束
      },
      {
        connection: connA,
        prefix: TASK_QUEUE_PREFIX,
        concurrency: 1,
        lockDuration: 800,
        stalledInterval: 200,
      }
    );
    try {
      await reactivateTask("it-stalled-1");
      const q = (await import("@server/services/worker/queue")).getTaskQueue();
      await waitForState(
        async () => (await q.getJob("it-stalled-1"))?.getState() ?? null,
        "active",
        "it-stalled-1 active on A"
      );

      // 模拟进程死亡：直接断开连接（不走 close 的优雅锁释放），Redis 侧锁残留
      void workerA.disconnect();

      // 接管者：stalled 检测发现锁过期（lockDuration 800ms）后重跑
      const connB = createQueueConnection();
      const workerB = new Worker(TASK_QUEUE_NAME, async () => {}, {
        connection: connB,
        prefix: TASK_QUEUE_PREFIX,
        concurrency: 1,
        lockDuration: 800,
        stalledInterval: 200,
      });
      try {
        await waitForState(
          async () => (await q.getJob("it-stalled-1"))?.getState() ?? null,
          "completed",
          "it-stalled-1 completed after stalled takeover"
        );
      } finally {
        await workerB.close();
        connB.disconnect();
      }
    } finally {
      connA.disconnect();
    }
  }, 25000);

  afterAll(async () => {
    await closeTaskQueue();
    // 清理本测试在专用 DB index 中的全部前缀键（禁止对共享实例 flushdb）
    let cursor = "0";
    do {
      const [next, keys] = await admin.scan(cursor, "MATCH", `${TASK_QUEUE_PREFIX}*`, "COUNT", 200);
      cursor = next;
      if (keys.length > 0) await admin.del(...keys);
    } while (cursor !== "0");
    admin.disconnect();
  }, 15000);
});
