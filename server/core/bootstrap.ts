/**
 * 服务启动引导。
 * 幂等初始化配置、数据库迁移、任务队列、网关等全局依赖，
 * 供 HTTP 服务与 Worker（BullMQ）在同进程中共用。
 */
import { assertDatabaseUrl, describeDatabaseTarget } from "@server/core/database/connection-string";
import { loadConfig } from "@server/core/config";
import { getSetting, initSettings } from "@server/core/settings";
import { getQueueHealth, initTaskQueue } from "@server/services/worker/queue";
import { isTaskWorkerRunning } from "@server/services/worker/worker";
import { metrics } from "@server/core/metrics";
import { initRateLimit } from "@server/core/ratelimit";
import { initRequestPathRedis } from "@server/core/redis/client";
import { logEvent } from "@server/core/logger/utils";

let initialized = false;

export async function bootstrap(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // 1. 加载配置
  const cfg = loadConfig();
  logEvent("bootstrap", { stage: "config_loaded", logLevel: cfg.LOG_LEVEL });

  // 2. 数据库连接串校验：单一运行时（外置 PostgreSQL）。应用启动不执行迁移，
  //    schema 由部署侧 `prisma migrate deploy`（entrypoint / 流水线）在启动前应用。
  const databaseUrl = assertDatabaseUrl();
  logEvent("bootstrap", {
    stage: "database_ready",
    target: describeDatabaseTarget(databaseUrl),
  });

  // 3. 系统设置：补齐缺失键并读入快照（依赖数据库，必须在连接校验之后）
  await initSettings();
  logEvent("bootstrap", { stage: "settings_loaded" });

  // 4. 任务队列探测（规则 7）：PING 失败即启动失败——Redis 宕机时启动期快速暴露，
  //    禁止带着不可用队列进入服务态（运行期瞬断由 stalled / 清扫自愈兜底）
  await initTaskQueue();
  logEvent("bootstrap", { stage: "queue_ready" });

  // 5. 请求路径 Redis（限流与鉴权快照共用一条连接）：启动期 PING 失败直接失败；
  //    运行期命令失败由各上层兜底（限流 fail-open、鉴权快照回源数据库）
  await initRequestPathRedis();
  await initRateLimit();
  logEvent("bootstrap", { stage: "rate_limit_ready" });

  // 6. initGateway（懒加载，避免循环依赖）
  // 初始化失败直接让进程崩溃：注册表缺失意味着所有协议/能力路由不可用，
  // 静默跳过只会让第一个请求才暴露问题
  const { initGateway } = await import("@server/services/gateway/registry");
  initGateway();
  logEvent("bootstrap", { stage: "gateway_initialized" });

  // 7. 存储层：按 `storage.backend` 设置构建进程级后端单例（不支持热切换，
  //    参数变更重启生效）。s3 后端启动即做六项能力探测（连通/写/读/回读/覆盖头/CORS），
  //    致命项失败直接抛错终止启动——禁止静默降级到 local，也禁止带病进入服务态
  //    （specs/storage-provider-portability.md 规则 3）。
  //    再清空本地工作区临时目录：只剩上个进程进行中写入的残骸，
  //    必须在 HTTP 服务与 Worker 开始写入之前完成；清理失败只多占磁盘、
  //    不影响正确性（临时文件名唯一），记录后继续启动
  const { initStorageBackend, probeStorageBackend } = await import("@server/services/storage/service");
  initStorageBackend();
  const probe = await probeStorageBackend();
  if (probe) metrics.storageProbe(probe);
  // 一条结构化日志收口探测摘要（规则 3.7）：provider / 寻址 / 能力位 / 时钟 / CORS
  logEvent("bootstrap", {
    stage: "storage_backend_ready",
    backend: getSetting("storage.backend"),
    maxLen: Infinity,
    ...(probe
      ? {
          provider: probe.provider,
          addressing: probe.capabilities.addressing,
          responseOverrides: probe.capabilities.responseOverrides,
          browserCors: probe.capabilities.browserCors,
          clockSkewSeconds: probe.clockSkewSeconds,
          warnings: probe.warnings,
        }
      : {}),
  });
  const { clearTmpDir, tmpDir } = await import("@server/services/storage/workspace");
  try {
    await clearTmpDir();
    logEvent("bootstrap", { stage: "storage_tmp_cleared" });
  } catch (err) {
    logEvent("bootstrap", {
      level: "warn",
      stage: "storage_tmp_clear_failed",
      dir: tmpDir(),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 8. 存储引用 GC 循环（幂等，内部自带延迟首跑与异常兜底）
  const { startStorageGc } = await import("@server/services/storage/gc");
  startStorageGc();
  logEvent("bootstrap", { stage: "storage_gc_scheduled" });

  // 队列与 worker 是抓取时读数（Gauge collect）：核心指标层不反向依赖 services，
  // 读取函数由引导期注入一次
  metrics.registerQueueGauges(async () => {
    const queue = await getQueueHealth();
    return { queueDepth: queue.queueDepth, workerRunning: isTaskWorkerRunning() };
  });

  logEvent("bootstrap", { stage: "done" });
}
