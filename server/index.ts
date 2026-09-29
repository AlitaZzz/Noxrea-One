/**
 * Server 进程入口：HTTP 服务 + Worker 循环（同进程）
 *
 * 替代旧架构中 web（Next.js API）+ worker（独立进程）的双进程模型。
 * - HTTP 由 Hono 提供，监听 SERVER_PORT（默认 4000）
 * - Worker 循环异步运行（p-limit 并发，不阻塞事件循环）
 */
import { bootstrap } from "@server/core/bootstrap";
import { workerLoop, type StopSignal } from "@server/services/worker/loop";
import { prisma } from "@server/core/database/client";
import { taskWatcher } from "@server/services/tasks/watcher";
import { logger } from "@server/core/logger";
import { logEvent } from "@server/core/logger/utils";
import { getConfig } from "@server/core/config";
import { startServer, stopServer } from "@server/http/server";

async function main(): Promise<void> {
  logEvent("server", { stage: "starting" });

  // 1. 初始化（配置、PRAGMA、Gateway）
  await bootstrap();

  // 2. 启动 HTTP 服务器
  await startServer();

  // 3. 启动 Worker 循环（异步，不阻塞事件循环）
  const shutdownController = new AbortController();
  const stopSignal: StopSignal = {
    stopped: false,
    signal: shutdownController.signal,
    abort: () => shutdownController.abort(),
  };
  const workerPromise = workerLoop(stopSignal).catch((err) => {
    logger.error({ err }, "Worker loop crashed");
  });

  // 4. 优雅停机
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent("server", { stage: "shutdown_requested" });

    // 4a. 信号 Worker 停止领取新任务
    stopSignal.stopped = true;

    // 4b. 停止接受新 HTTP 连接
    await stopServer();

    taskWatcher.dispose();

    // 4c. 等 Worker 排空在途任务。排空超时的强制收尾由 workerLoop 内部完成：
    //     abort 在途上游请求/轮询后再等一个窗口让 Promise 落定（约 2×WORKER_DRAIN_TIMEOUT），
    //     这里只设更大的进程退出兜底时限
    const exitBound = getConfig().WORKER_DRAIN_TIMEOUT * 1000 * 3;
    await Promise.race([
      workerPromise,
      new Promise<void>((r) => setTimeout(r, exitBound)),
    ]);

    // 4d. 断开数据库
    await prisma.$disconnect();
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
