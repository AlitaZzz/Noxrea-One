/**
 * 服务启动引导。
 * 幂等初始化配置、数据库 PRAGMA、网关等全局依赖，
 * 供 HTTP 服务与 Worker 循环在同进程中共用。
 */
import { applyPragmas } from "@server/core/database/client";
import { loadConfig } from "@server/core/config";
import { logger } from "@server/core/logger";
import { logEvent } from "@server/core/logger/utils";

let initialized = false;

export async function bootstrap(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // 1. 加载配置
  const cfg = loadConfig();
  logEvent("bootstrap", { stage: "config_loaded", logLevel: cfg.LOG_LEVEL });

  // 2. PRAGMA（SQLite WAL）
  await applyPragmas();
  logEvent("bootstrap", { stage: "pragmas_applied" });

  // 3. initGateway（懒加载，避免循环依赖）
  try {
    const { initGateway } = await import(
      "@server/services/gateway/registry"
    );
    initGateway();
    logEvent("bootstrap", { stage: "gateway_initialized" });
  } catch (err) {
    logger.warn({ err }, "Gateway init skipped (services not yet available)");
  }

  logEvent("bootstrap", { stage: "done" });
}
