/**
 * 服务启动引导。
 * 幂等初始化配置、数据库迁移、任务队列、网关等全局依赖，
 * 供 HTTP 服务与 Worker（BullMQ）在同进程中共用。
 */
import { describeConnectionTarget, ensureLocalMigrations, isServerMode } from "@server/core/database/client";
import { loadConfig } from "@server/core/config";
import { getSetting, initSettings } from "@server/core/settings";
import { initTaskQueue } from "@server/services/worker/queue";
import { logEvent } from "@server/core/logger/utils";

let initialized = false;

export async function bootstrap(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // 1. 加载配置
  const cfg = loadConfig();
  logEvent("bootstrap", { stage: "config_loaded", logLevel: cfg.LOG_LEVEL });

  // 2. 数据库迁移：本地模式（PGlite）应用 prisma/migrations 增量；服务器模式由部署侧 migrate deploy 负责
  await ensureLocalMigrations();
  logEvent("bootstrap", {
    stage: "database_ready",
    mode: isServerMode() ? "server" : "local",
    target: describeConnectionTarget(),
  });

  // 3. 系统设置：补齐缺失键并读入快照（依赖数据库，必须在迁移之后）
  await initSettings();
  logEvent("bootstrap", { stage: "settings_loaded" });

  // 4. 任务队列探测（规则 7）：PING 失败即启动失败——Redis 宕机时启动期快速暴露，
  //    禁止带着不可用队列进入服务态（运行期瞬断由 stalled / 清扫自愈兜底）
  await initTaskQueue();
  logEvent("bootstrap", { stage: "queue_ready" });

  // 5. initGateway（懒加载，避免循环依赖）
  // 初始化失败直接让进程崩溃：注册表缺失意味着所有协议/能力路由不可用，
  // 静默跳过只会让第一个请求才暴露问题
  const { initGateway } = await import("@server/services/gateway/registry");
  initGateway();
  logEvent("bootstrap", { stage: "gateway_initialized" });

  // 6. 存储层：按 `storage.backend` 设置构建进程级后端单例（不支持热切换，
  //    参数变更重启生效）。s3 后端启动即 HeadBucket 探测端点与凭据，
  //    失败直接抛错终止启动——禁止静默降级到 local（spec 业务规则 10）。
  //    再清空本地工作区临时目录：只剩上个进程进行中写入的残骸，
  //    必须在 HTTP 服务与 Worker 开始写入之前完成；清理失败只多占磁盘、
  //    不影响正确性（临时文件名唯一），记录后继续启动
  const { initStorageBackend, getStorageBackend } = await import("@server/services/storage/service");
  initStorageBackend();
  await getStorageBackend().probe?.();
  logEvent("bootstrap", { stage: "storage_backend_ready", backend: getSetting("storage.backend") });
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

  // 7. 存储引用 GC 循环（幂等，内部自带延迟首跑与异常兜底）
  const { startStorageGc } = await import("@server/services/storage/gc");
  startStorageGc();
  logEvent("bootstrap", { stage: "storage_gc_scheduled" });

  logEvent("bootstrap", { stage: "done" });
}
