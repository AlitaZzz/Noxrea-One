import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  createTask: vi.fn(),
  getTask: vi.fn(),
  cancelTask: vi.fn(),
  getTaskTerminalByIds: vi.fn(),
  getProvider: vi.fn(),
  getAllowedFields: vi.fn(),
  taskWatcher: {},
  quotaGate: vi.fn(),
  reactivateBestEffort: vi.fn(),
  cancelQueuedTask: vi.fn(),
}));

vi.mock("@server/http/middleware/auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));
vi.mock("@server/crud/task", () => ({
  createTask: mocks.createTask,
  getTask: mocks.getTask,
  cancelTask: mocks.cancelTask,
  getTaskTerminalByIds: mocks.getTaskTerminalByIds,
  isTerminalTaskStatus: vi.fn(),
  toTerminalState: vi.fn(),
}));
vi.mock("@server/crud/model-config", () => ({
  getProvider: mocks.getProvider,
}));
vi.mock("@server/services/model-config", () => ({
  getAllowedFields: mocks.getAllowedFields,
  normalizeCapability: vi.fn((value: string) => value),
  hostFromBaseUrl: vi.fn(() => "example.com"),
  resolveMatchedHost: vi.fn(() => "_default"),
}));
vi.mock("@server/services/tasks/watcher", () => ({
  taskWatcher: mocks.taskWatcher,
}));
vi.mock("@server/http/sse", () => ({
  createSseResponse: vi.fn(),
}));
vi.mock("@server/core/logger/utils", () => ({
  logEvent: vi.fn(),
  errText: vi.fn(),
}));
vi.mock("@server/services/storage/service", () => ({
  buildFileUrl: vi.fn((key: string) => `/api/files/${key}`),
  getStorageBackend: () => ({ stat: vi.fn(async () => null) }),
}));
vi.mock("@server/services/storage/quota", () => ({
  findQuotaGateViolation: mocks.quotaGate,
}));
vi.mock("@server/services/worker/queue", () => ({
  reactivateBestEffort: mocks.reactivateBestEffort,
  cancelQueuedTask: mocks.cancelQueuedTask,
}));

import { router } from "@server/http/routes/generate";
import { jsonBodyLimit } from "@server/http/middleware/body-limit";
import { Hono } from "hono";

// 与 app.ts 的装配一致：生成任务走 1MB JSON 上限
const app = new Hono();
app.use("/api/generate/*", jsonBodyLimit(1024 * 1024));
app.route("/", router);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reactivateBestEffort.mockResolvedValue("added");
  mocks.cancelQueuedTask.mockResolvedValue(undefined);
});

describe("生成任务请求体限制", () => {
  it("无 Content-Length 的流式请求按实际大小拒绝超过 1MB 的载荷", async () => {
    const response = await app.request("/api/generate/task", {
      method: "POST",
      body: "x".repeat(1024 * 1024 + 1),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "common.body_too_large" });
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});

describe("创建任务入参校验", () => {
  beforeEach(() => {
    mocks.authenticateRequest.mockResolvedValue({ user: { id: 1 } });
    mocks.getProvider.mockResolvedValue({
      id: 7,
      protocol: "openai",
      baseUrl: "http://upstream.test",
    });
    mocks.getAllowedFields.mockReturnValue([]);
    mocks.createTask.mockResolvedValue({ id: "task-1" });
    mocks.quotaGate.mockResolvedValue(null);
  });

  it("type 非枚举值（audio 生成未开放）被 zod 拒绝", async () => {
    const response = await app.request("/api/generate/task", {
      method: "POST",
      body: JSON.stringify({ type: "audio", providerId: 7 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "common.invalid_request" });
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("客户端传 protocol 被忽略，任务协议恒取 provider.protocol（A5 回归）", async () => {
    const response = await app.request("/api/generate/task", {
      method: "POST",
      body: JSON.stringify({ type: "image", providerId: 7, protocol: "ark", model: "m" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: "openai" })
    );
    const config = mocks.createTask.mock.calls[0][0].config as Record<string, unknown>;
    expect(config).not.toHaveProperty("protocol");
  });

  it("创建成功后经重激活原语派发（规则 7）", async () => {
    const response = await app.request("/api/generate/task", {
      method: "POST",
      body: JSON.stringify({ type: "image", providerId: 7 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(mocks.reactivateBestEffort).toHaveBeenCalledWith("task-1", {
      channel: "http.generate",
      stage: "enqueue_failed",
    });
  });

  it("入队失败不回滚不 503：任务创建成功返回，派发交对账清扫自愈（规则 7）", async () => {
    mocks.reactivateBestEffort.mockResolvedValue(null); // 自愈语义单源：失败返回 null 不抛

    const response = await app.request("/api/generate/task", {
      method: "POST",
      body: JSON.stringify({ type: "image", providerId: 7 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { id: "task-1" } });
  });
});

describe("存储配额二元门槛（specs/storage-user-quota.md 规则 3）", () => {
  beforeEach(() => {
    mocks.authenticateRequest.mockResolvedValue({ user: { id: 1 } });
    mocks.getProvider.mockResolvedValue({
      id: 7,
      protocol: "openai",
      baseUrl: "http://upstream.test",
    });
    mocks.getAllowedFields.mockReturnValue([]);
    mocks.createTask.mockResolvedValue({ id: "task-1" });
  });

  const post = () =>
    app.request("/api/generate/task", {
      method: "POST",
      body: JSON.stringify({ type: "image", providerId: 7 }),
      headers: { "Content-Type": "application/json" },
    });

  it("配额启用且已无余量：409 generate.quota_exceeded 携带用量上下文，不创建任务", async () => {
    mocks.quotaGate.mockResolvedValueOnce({ usedBytes: 10, quotaBytes: 5 });

    const response = await post();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "generate.quota_exceeded",
      ctx: { usedBytes: 10, quotaBytes: 5 },
    });
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("不限量（门槛返回 null）正常创建任务", async () => {
    mocks.quotaGate.mockResolvedValue(null);

    const response = await post();

    expect(response.status).toBe(200);
    expect(mocks.createTask).toHaveBeenCalledTimes(1);
  });
});
