/**
 * 健康检查（specs/observability-baseline.md 规则 1）。
 *
 * 存活与就绪是两种语义，分开暴露：
 * - `/api/health/live`：只证明进程在跑，无条件 200。事件循环被阻塞到无法响应时
 *   自然超时——这才是存活探针该抓的故障。
 * - `/api/health/ready`：依赖就绪。致命项（数据库 / Redis / 存储探测）任一失败即 503，
 *   编排层据此摘流但**不重启**：把就绪端点配成存活探针，会让一次可自愈的 Redis 抖动
 *   放大成全量重启。
 *
 * 响应是扁平 JSON 而不是全站响应信封：消费方是编排层与探针脚本，它们只看状态码与
 * 布尔项，不解析 `code` / `msg`；信封在这里只会让探针配置更难写。
 * `checks` 只含布尔与数值，不含错误文本、端点、桶名（规则 1.3）。
 */
import { Hono } from "hono";

import { prisma } from "@server/core/database/client";
import { getRequestPathRedis } from "@server/core/redis/client";
import { storageReady } from "@server/services/storage/service";
import { getQueueHealth } from "@server/services/worker/queue";
import { isTaskWorkerRunning } from "@server/services/worker/worker";

const router = new Hono();

/** 依赖检查超时（规则 1.2）：就绪探针自身不得成为慢请求 */
const DATABASE_TIMEOUT_MS = 2_000;
const REDIS_TIMEOUT_MS = 1_000;

interface ReadyChecks {
  database: boolean;
  redis: boolean;
  /** worker 只在部分部署中运行（纯 Web 实例）：报告但不参与就绪判定 */
  worker: boolean;
  /** waiting + delayed + active；Redis 不可达时为 null（不用 0 冒充「无积压」） */
  queueDepth: number | null;
  /** s3 后端：启动探测能力摘要存在；local 后端无此项，恒为 true */
  storage: boolean;
}

/** 带超时的布尔化执行：超时与异常一律视为该项不可用 */
async function settlesWithin(run: () => Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

router.get("/api/health/live", (c) => c.json({ status: "ok" }));

router.get("/api/health/ready", async (c) => {
  const [database, redis] = await Promise.all([
    settlesWithin(() => prisma.$queryRaw`SELECT 1`, DATABASE_TIMEOUT_MS),
    settlesWithin(() => {
      const client = getRequestPathRedis();
      // 未初始化即不可用：就绪检查不会替引导流程兜底
      return client ? client.ping() : Promise.reject(new Error("redis not initialized"));
    }, REDIS_TIMEOUT_MS),
  ]);

  const queue = await getQueueHealth();
  const checks: ReadyChecks = {
    database,
    redis,
    worker: isTaskWorkerRunning(),
    // 队列读数与就绪口径同源：Redis 不可达时两者都是不可用
    queueDepth: queue.queueDepth,
    storage: storageReady(),
  };

  // 致命项：数据库 / Redis / 存储探测。worker 不参与（纯 Web 部署合法，
  // 且 worker 停摆只影响异步任务，队列深度指标另有告警口径）
  const ready = checks.database && checks.redis && checks.storage;
  return c.json(
    ready ? { status: "ready", checks } : { status: "not_ready", checks },
    ready ? 200 : 503,
  );
});

export { router };
