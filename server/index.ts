/**
 * Server 进程入口：HTTP 服务 + BullMQ Worker（同进程，specs/task-queue-bullmq.md）
 *
 * 替代旧架构中 web（Next.js API）+ worker（独立进程）的双进程模型。
 * - HTTP 由 Hono 提供，监听 API_PORT（默认 4000）
 * - Worker（BullMQ）与对账清扫异步运行，不阻塞事件循环
 */
import { bootstrap } from "@server/core/bootstrap";
import { startTaskWorker, stopTaskWorker } from "@server/services/worker/worker";
import { startReconcileSweep, stopReconcileSweep } from "@server/services/worker/reconcile";
import { closeTaskQueue } from "@server/services/worker/queue";
import { closeLocalDatabase, prisma } from "@server/core/database/client";
import { taskWatcher } from "@server/services/tasks/watcher";
import { logger } from "@server/core/logger";
import { logEvent } from "@server/core/logger/utils";
import { getSetting } from "@server/core/settings";
import { startServer, stopServer } from "@server/http/server";

async function main(): Promise<void> {
  logEvent("server", { stage: "starting" });

  // 1. 初始化（配置、迁移、设置、Redis 探测、Gateway、存储、GC）
  await bootstrap();

  // 2. 启动 HTTP 服务器
  await startServer();

  // 3. 启动 Worker 与对账清扫（异步，不阻塞事件循环）
  startTaskWorker();
  startReconcileSweep();

  // 4. 优雅停机（规则 9：先 HTTP 后 Worker，再队列与数据库）
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent("server", { stage: "shutdown_requested" });

    // 4a. 停止接受新 HTTP 连接
    await stopServer();

    // 4b. 停止清扫定时器（停机期间不再发起重激活）
    stopReconcileSweep();

    // 4c. Worker 排空：停止接新 job → drain 窗口 → 超时 abort 在途 → 有界等待 → 强制关闭。
    //     内部时序见 stopTaskWorker；这里只设更大的进程退出兜底时限
    const exitBound = getSetting("worker.drain_timeout_seconds") * 1000 * 3;
    await Promise.race([
      stopTaskWorker(),
      new Promise<void>((r) => setTimeout(r, exitBound)),
    ]);

    taskWatcher.dispose();

    // 4d. 关闭队列连接，断开数据库并关闭本地模式 PGlite
    //     （close 触发 checkpoint 把 WAL 落盘 + 释放数据目录锁）
    await closeTaskQueue();
    await prisma.$disconnect();
    await closeLocalDatabase();
    logEvent("server", { stage: "shutdown_complete" });
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((err) => {
  logger.fatal({ err }, "Server crashed");
  process.exit(1);
});
