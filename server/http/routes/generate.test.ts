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
}));
vi.mock("@server/services/storage/backends/local", () => ({
  localStorage: { stat: vi.fn() },
}));

import { router } from "./generate";
import { jsonBodyLimit } from "@server/http/middleware/body-limit";
import { Hono } from "hono";

// 与 app.ts 的装配一致：生成任务走 1MB JSON 上限
const app = new Hono();
app.use("/api/generate/*", jsonBodyLimit(1024 * 1024));
app.route("/", router);

beforeEach(() => {
  vi.clearAllMocks();
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
