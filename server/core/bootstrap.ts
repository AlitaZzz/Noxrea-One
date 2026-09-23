/**
 * 服务启动引导。
 * 幂等初始化配置、数据库 PRAGMA、网关等全局依赖，
 * 供 HTTP 服务与 Worker 循环在同进程中共用。
 */
import { applyPragmas } from "@server/core/database/client";
import { loadConfig } from "@server/core/config";
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
  // 初始化失败直接让进程崩溃：注册表缺失意味着所有协议/能力路由不可用，
  // 静默跳过只会让第一个请求才暴露问题
  const { initGateway } = await import("@server/services/gateway/registry");
  initGateway();
  logEvent("bootstrap", { stage: "gateway_initialized" });

  logEvent("bootstrap", { stage: "done" });
}
