/**
 * 指标声明与写入 helper（specs/observability-baseline.md 规则 3）。
 *
 * 两条纪律集中在这里：
 * - 标签集合声明为常量，调用方只能传联合类型内的值（规则 3.8）：用户 id、存储 key、
 *   文件名、URL、错误文本、请求 ID 一律不得成为标签；
 * - 注册表单例按 `globalThis` 缓存（与数据库客户端同一手法）：模块被重复加载
 *   （测试 resetModules、热重载）不会抛「already registered」（规则 3.9）。
 *
 * 子系统只调用具名 helper，不自己拼标签或 new 指标。
 */
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "@prometheus-io/client";

/*
 * 标签取值集合（规则 3.8）：声明为联合类型，调用方只能传集合内的值。
 * 这里不另建运行期常量——取值只用于类型约束，没有运行期消费方。
 */

/**
 * 鉴权快照结果（`server/core/auth/snapshot.ts`）。
 *
 * 读路径：`hit` / `miss` / `db_fallback`（无 Redis 连接）/ `error`（Redis 命令失败）。
 * 写路径（改密 / 禁用后的失效）：`invalidated`（SET 成功）/ `invalidated_fallback`
 * （SET 失败退化为 DEL）/ `invalidate_error`（SET 与 DEL 均失败）。
 *
 * 读写两类结果同表：两者共用同一个键空间与同一份失败语义，分表会让「快照不可用
 * 的总体比例」需要跨两个指标求和。
 */
type AuthSnapshotResult =
  | "hit"
  | "miss"
  | "db_fallback"
  | "error"
  | "invalidated"
  | "invalidated_fallback"
  | "invalidate_error";

/** 描述接口的两种形态（`server/http/routes/files.ts`） */
type FileAccessDelivery = "signed" | "stream";
type FileAccessResult = "ok" | "error";

/**
 * 派生产物四个命名空间（`_cache` / `_posters` / `_sprite` / `_proxy`）。标签取值集合
 * 按规则 3.8 在 metrics 声明；档位由 key 的命名空间推导（`derived-keys.derivedTierOf`），
 * 调用方不手写——两处取值一旦不同集，`ensureArtifact` 的调用点会编译失败。
 */
type DerivedTier = "cache" | "poster" | "sprite" | "proxy";
/** `skipped`：按设计不生成（如 APNG 退回原图），不计入失败率 */
type DerivedResult = "hit" | "generated" | "failed" | "skipped";

type PresignResult = "ok" | "failed";
/**
 * GC 单周期结果：四个阶段（引用回收 / staging 清扫 / 派生清扫 / 探测残留清扫）独立成败。
 *
 * 只有四阶段全成才记 `ok`：某一阶段持续失败时 `ok` 仍会一路增长，按指标告警会
 * 完全漏报（失败只落在日志里，而日志不聚合）。`partial` 因此必须是一个可告警的
 * 终态，而不是被 `ok` 吞掉。
 */
export type GcResult = "ok" | "partial" | "failed";
type StorageAddressingLabel = "path" | "virtual";

/** HTTP 方法标签的有界集合：未知方法归入 OTHER，避免任意字符串成为标签 */
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/** 路由标签：无法匹配到模板的请求（404 等）统一记为 other（规则 3.2） */
export const UNMATCHED_ROUTE_LABEL = "other";

/** 直方图桶（规则 3.1 / 3.3）：5ms–10s 通用分布，覆盖一次请求的常见量级 */
const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
/** 鉴权验签耗时的量级与 HTTP 相同，但集中在毫秒级 */
const AUTH_DURATION_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];
/** 单批描述条数：1–50（`FILE_ACCESS_BATCH_LIMIT`），桶按批量语义取 */
const BATCH_SIZE_BUCKETS = [1, 2, 5, 10, 20, 30, 40, 50];

interface MetricsHandle {
  readonly registry: Registry;
  httpRequest(method: string, route: string, status: number, durationSeconds: number): void;
  authSnapshot(result: AuthSnapshotResult): void;
  authVerify(durationSeconds: number): void;
  fileAccessDescribe(delivery: FileAccessDelivery, result: FileAccessResult): void;
  fileAccessBatchSize(size: number): void;
  presign(result: PresignResult): void;
  derivedArtifact(tier: DerivedTier, result: DerivedResult): void;
  mediaBusyRejected(): void;
  storageGcRun(result: GcResult, reclaimedBytes: number): void;
  storageProbe(report: {
    capabilities: { addressing: StorageAddressingLabel; responseOverrides: boolean; browserCors: boolean };
    clockSkewSeconds: number;
  }): void;
  /** 队列与 worker 的抓取时读数（Gauge collect）：由调用方提供读取函数，core 不反向依赖 services */
  registerQueueGauges(read: () => Promise<{ queueDepth: number | null; workerRunning: boolean }>): void;
}

const METRICS_KEY = Symbol.for("noxrea.metrics");

function createMetrics(): MetricsHandle {
  const registry = new Registry();
  // 进程级默认指标（CPU / 内存 / 事件循环 / GC）：零维护成本，排障第一现场
  collectDefaultMetrics({ register: registry });

  const httpRequestsTotal = new Counter({
    name: "http_requests_total",
    help: "HTTP requests by method, route template and status",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });
  const httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration by method and route template",
    labelNames: ["method", "route"],
    buckets: HTTP_DURATION_BUCKETS,
    registers: [registry],
  });
  const authSnapshotTotal = new Counter({
    name: "auth_snapshot_total",
    help: "Auth snapshot lookups by result",
    labelNames: ["result"],
    registers: [registry],
  });
  const authVerifyDuration = new Histogram({
    name: "auth_verify_duration_seconds",
    help: "Auth verification duration (snapshot read or database fallback)",
    buckets: AUTH_DURATION_BUCKETS,
    registers: [registry],
  });
  const fileAccessDescribeTotal = new Counter({
    name: "file_access_describe_total",
    help: "File access descriptors by delivery form and result",
    labelNames: ["delivery", "result"],
    registers: [registry],
  });
  const fileAccessBatchSize = new Histogram({
    name: "file_access_batch_size",
    help: "Descriptor batch sizes",
    buckets: BATCH_SIZE_BUCKETS,
    registers: [registry],
  });
  const presignTotal = new Counter({
    name: "presign_total",
    help: "Presigned URL signing results",
    labelNames: ["result"],
    registers: [registry],
  });
  const derivedArtifactTotal = new Counter({
    name: "derived_artifact_total",
    help: "Derived artifacts by tier and result",
    labelNames: ["tier", "result"],
    registers: [registry],
  });
  const mediaBusyRejectedTotal = new Counter({
    name: "media_busy_rejected_total",
    help: "Media pool rejections",
    registers: [registry],
  });
  const storageGcRunsTotal = new Counter({
    name: "storage_gc_runs_total",
    help: "Storage GC runs by result",
    labelNames: ["result"],
    registers: [registry],
  });
  const storageGcReclaimedBytesTotal = new Counter({
    name: "storage_gc_reclaimed_bytes_total",
    help: "Bytes reclaimed by storage GC",
    registers: [registry],
  });
  const storageProbeOk = new Gauge({
    name: "storage_probe_ok",
    help: "Storage startup probe passed (1) with capability bits as labels",
    labelNames: ["addressing", "response_overrides", "browser_cors"],
    registers: [registry],
  });
  const storageProbeClockSkew = new Gauge({
    name: "storage_probe_clock_skew_seconds",
    help: "Endpoint clock skew measured at startup",
    registers: [registry],
  });

  let queueGaugesRegistered = false;

  return {
    registry,
    httpRequest(method, route, status, durationSeconds) {
      const methodLabel = (HTTP_METHODS as readonly string[]).includes(method)
        ? method
        : "OTHER";
      httpRequestsTotal.inc({ method: methodLabel, route, status: String(status) });
      httpRequestDuration.observe({ method: methodLabel, route }, durationSeconds);
    },
    authSnapshot(result) {
      authSnapshotTotal.inc({ result });
    },
    authVerify(durationSeconds) {
      authVerifyDuration.observe(durationSeconds);
    },
    fileAccessDescribe(delivery, result) {
      fileAccessDescribeTotal.inc({ delivery, result });
    },
    fileAccessBatchSize(size) {
      fileAccessBatchSize.observe(size);
    },
    presign(result) {
      presignTotal.inc({ result });
    },
    derivedArtifact(tier, result) {
      derivedArtifactTotal.inc({ tier, result });
    },
    mediaBusyRejected() {
      mediaBusyRejectedTotal.inc();
    },
    storageGcRun(result, reclaimedBytes) {
      storageGcRunsTotal.inc({ result });
      if (reclaimedBytes > 0) storageGcReclaimedBytesTotal.inc(reclaimedBytes);
    },
    storageProbe(report) {
      const { addressing, responseOverrides, browserCors } = report.capabilities;
      storageProbeOk.set(
        {
          addressing,
          response_overrides: String(responseOverrides),
          browser_cors: String(browserCors),
        },
        1,
      );
      storageProbeClockSkew.set(report.clockSkewSeconds);
    },
    registerQueueGauges(read) {
      if (queueGaugesRegistered) return;
      queueGaugesRegistered = true;
      new Gauge({
        name: "queue_depth",
        help: "BullMQ waiting + delayed + active jobs",
        registers: [registry],
        async collect() {
          const { queueDepth } = await read();
          // Redis 不可达时置 0 会冒充「无积压」：保持上一个观测值不动
          if (queueDepth !== null) this.set(queueDepth);
        },
      });
      new Gauge({
        name: "worker_up",
        help: "Task worker running in this process (1) or not (0)",
        registers: [registry],
        async collect() {
          const { workerRunning } = await read();
          this.set(workerRunning ? 1 : 0);
        },
      });
    },
  };
}

/**
 * 进程级指标句柄。重复导入返回同一实例：注册表与指标对象都不可重复创建，
 * 否则客户端会因同名指标二次注册而抛错（规则 3.9）。
 */
export const metrics: MetricsHandle = (() => {
  const holder = globalThis as { [METRICS_KEY]?: MetricsHandle };
  holder[METRICS_KEY] ??= createMetrics();
  return holder[METRICS_KEY]!;
})();
