/**
 * 可观测性基线（specs/observability-baseline.md）路由与中间件验证：
 * - 健康检查分层：live 无条件 200；ready 按致命项给 200/503，checks 只含布尔与数值；
 * - 指标端点：默认 404，开启后 Bearer 校验，200 返回 Prometheus 文本；
 * - 访问日志 + HTTP 指标：路由模板与状态码，查询串不落日志，/metrics 自身不计数；
 * - 标签纪律：不同存储 key 不产生新序列。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(),
  config: { METRICS_ENABLED: false, METRICS_TOKEN: "", LOG_LEVEL: "silent" },
  queryRaw: vi.fn(),
  ping: vi.fn(),
  redis: null as { ping: () => Promise<string> } | null,
  queueHealth: vi.fn(),
  workerRunning: vi.fn(),
  storageReady: vi.fn(),
}));

vi.mock("@server/core/logger/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@server/core/logger/utils")>()),
  logEvent: mocks.logEvent,
}));
vi.mock("@server/core/config", () => ({
  getConfig: () => mocks.config,
  loadConfig: () => mocks.config,
}));
vi.mock("@server/core/database/client", () => ({ prisma: { $queryRaw: mocks.queryRaw } }));
vi.mock("@server/core/redis/client", () => ({ getRequestPathRedis: () => mocks.redis }));
vi.mock("@server/services/worker/queue", () => ({ getQueueHealth: mocks.queueHealth }));
vi.mock("@server/services/worker/worker", () => ({ isTaskWorkerRunning: mocks.workerRunning }));
vi.mock("@server/services/storage/service", () => ({ storageReady: mocks.storageReady }));

import { metrics } from "@server/core/metrics";
import { getRequestContext } from "@server/core/logger/context";
import { requestId } from "@server/http/middleware/request-id";
import { observability } from "@server/http/middleware/observability";
import { router as healthRouter } from "@server/http/routes/health";
import { router as metricsRouter } from "@server/http/routes/metrics";

const healthApp = new Hono();
healthApp.route("/", healthRouter);

const metricsApp = new Hono();
metricsApp.route("/", metricsRouter);

/** 访问日志 + 指标：与 app.ts 相同的挂载顺序（requestId → observability → 路由） */
const observedApp = new Hono();
observedApp.use("*", requestId());
observedApp.use("*", observability());
observedApp.get("/api/files/*", (c) => c.text("ok"));
observedApp.get("/api/boom", (c) => c.text("bad", 500));
observedApp.get("/api/probe-context", (c) => c.json({ requestId: getRequestContext()?.requestId ?? null }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.METRICS_ENABLED = false;
  mocks.config.METRICS_TOKEN = "";
  mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  mocks.ping.mockResolvedValue("PONG");
  mocks.redis = { ping: mocks.ping };
  mocks.queueHealth.mockResolvedValue({ redis: true, queueDepth: 3 });
  mocks.workerRunning.mockReturnValue(true);
  mocks.storageReady.mockReturnValue(true);
});

describe("健康检查（规则 1）", () => {
  it("live：无条件 200，不触碰任何依赖", async () => {
    mocks.redis = null;
    mocks.queryRaw.mockRejectedValue(new Error("db down"));
    const res = await healthApp.request("/api/health/live");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("ready：依赖全绿 → 200，checks 只含布尔与数值", async () => {
    const res = await healthApp.request("/api/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: Record<string, unknown> };
    expect(body.status).toBe("ready");
    expect(body.checks).toEqual({
      database: true,
      redis: true,
      worker: true,
      queueDepth: 3,
      storage: true,
    });
  });

  it("ready：Redis 不可用 → 503（摘流不重启），queueDepth 为 null 而非 0", async () => {
    mocks.redis = null;
    mocks.queueHealth.mockResolvedValue({ redis: false, queueDepth: null });
    const res = await healthApp.request("/api/health/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; checks: Record<string, unknown> };
    expect(body.status).toBe("not_ready");
    expect(body.checks).toMatchObject({ redis: false, queueDepth: null });
  });

  it("ready：数据库超时 → 503；worker 不在跑不参与就绪判定", async () => {
    mocks.queryRaw.mockImplementation(() => new Promise(() => {}));
    mocks.workerRunning.mockReturnValue(false);
    const res = await healthApp.request("/api/health/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { checks: Record<string, unknown> };
    expect(body.checks).toMatchObject({ database: false, worker: false });
  }, 10_000);

  it("ready：存储探测缺失（s3 未探测）→ 503", async () => {
    mocks.storageReady.mockReturnValue(false);
    const res = await healthApp.request("/api/health/ready");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { checks: Record<string, unknown> }).checks.storage).toBe(false);
  });

  it("旧路径 /api/health 已删除", async () => {
    const res = await healthApp.request("/api/health");
    expect(res.status).toBe(404);
  });
});

describe("指标端点（规则 2）", () => {
  it("默认关闭：404，不暴露端点存在性", async () => {
    const res = await metricsApp.request("/metrics");
    expect(res.status).toBe(404);
  });

  it("开启后无 token → 401；错误 token → 401", async () => {
    mocks.config.METRICS_ENABLED = true;
    mocks.config.METRICS_TOKEN = "s3cret-token";
    expect((await metricsApp.request("/metrics")).status).toBe(401);
    const wrong = await metricsApp.request("/metrics", {
      headers: { Authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("正确 token → 200，返回 Prometheus 文本且含已声明指标", async () => {
    mocks.config.METRICS_ENABLED = true;
    mocks.config.METRICS_TOKEN = "s3cret-token";
    const res = await metricsApp.request("/metrics", {
      headers: { Authorization: "Bearer s3cret-token" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    for (const name of [
      "http_requests_total",
      "auth_snapshot_total",
      "file_access_describe_total",
      "presign_total",
      "storage_probe_ok",
      "storage_probe_clock_skew_seconds",
      "derived_artifact_total",
      "media_busy_rejected_total",
    ]) {
      expect(text).toContain(name);
    }
  });
});

describe("访问日志与 HTTP 指标（规则 3.1 / 4）", () => {
  it("一条日志：方法 / 路由模板 / 状态 / 耗时；查询串（含签名参数）不落日志", async () => {
    const res = await observedApp.request("/api/files/9/ab/deadbeef.png?download=1&signature=secret-sig");
    expect(res.status).toBe(200);
    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    const [module, fields] = mocks.logEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(module).toBe("http");
    expect(fields).toMatchObject({ method: "GET", route: "/api/files/*", status: 200, level: "info" });
    expect(typeof fields.durationMs).toBe("number");
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("deadbeef");
  });

  it("日志级别随状态码：4xx → warn，5xx → error", async () => {
    await observedApp.request("/api/missing");
    const missing = mocks.logEvent.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(missing).toMatchObject({ status: 404, route: "other", level: "warn" });

    await observedApp.request("/api/boom");
    const boom = mocks.logEvent.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(boom).toMatchObject({ status: 500, level: "error" });
  });

  it("未捕获异常 → 500 记为 error（错误路径同样进访问日志）", async () => {
    const app = new Hono();
    app.use("*", requestId());
    app.use("*", observability());
    app.get("/api/throws", () => {
      throw new Error("boom");
    });
    app.onError((_err, c) => c.text("internal", 500));

    const res = await app.request("/api/throws");
    expect(res.status).toBe(500);
    const fields = mocks.logEvent.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(fields).toMatchObject({ status: 500, level: "error", route: "/api/throws" });
  });

  it("请求 ID 在同一异步上下文里可被日志取到（访问日志的 requestId 来源）", async () => {
    const res = await observedApp.request("/api/probe-context");
    const body = (await res.json()) as { requestId: string | null };
    expect(body.requestId).toBeTruthy();
    expect(body.requestId).toBe(res.headers.get("X-Request-Id"));
  });

  it("/metrics 自身不产生访问日志与 HTTP 指标（规则 2.4）", async () => {
    await metricsApp.request("/metrics");
    expect(mocks.logEvent).not.toHaveBeenCalled();
    const series = await metrics.registry.getSingleMetric("http_requests_total")!.get();
    expect(series.values.some((value) => value.labels.route === "/metrics")).toBe(false);
  });
});

describe("标签纪律（规则 3.7）", () => {
  it("描述计数的标签只有形态与结果：100 次调用不新增序列，也没有 key 类标签", async () => {
    const counter = metrics.registry.getSingleMetric("file_access_describe_total")!;
    metrics.fileAccessDescribe("signed", "ok");
    const before = (await counter.get()).values;
    for (let i = 0; i < 100; i += 1) metrics.fileAccessDescribe("signed", "ok");
    const after = (await counter.get()).values;
    expect(after.length).toBe(before.length);
    expect(Object.keys(after[0].labels).sort()).toEqual(["delivery", "result"]);
  });

  it("指标模块重复导入是同一实例（注册表不重复创建，规则 3.8）", async () => {
    vi.resetModules();
    const first = await import("@server/core/metrics");
    vi.resetModules();
    const second = await import("@server/core/metrics");
    expect(first.metrics).toBe(second.metrics);
  });
});
