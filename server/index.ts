/**
 * Worker 独立进程入口（npm run worker）
 */
import { bootstrap } from "@server/core/bootstrap";
import { workerLoop } from "@server/services/worker/loop";
import { prisma } from "@server/core/database/client";
import { logger } from "@server/core/logger";
import { logEvent } from "@server/core/logger/utils";

async function main(): Promise<void> {
  logEvent("worker", { stage: "starting" });

  await bootstrap();

  const stopSignal = { stopped: false };

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent("worker", { stage: "shutdown_requested" });

    stopSignal.stopped = true;

    await new Promise((r) => setTimeout(r, 15_000));
    await prisma.$disconnect();
    logEvent("worker", { stage: "shutdown_complete" });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await workerLoop(stopSignal);
}

main().catch((err) => {
  logger.fatal({ err }, "Worker crashed");
  process.exit(1);
});
