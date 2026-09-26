import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  runCompletion: vi.fn(),
  runCompletionStream: vi.fn(),
}));

vi.mock("@server/http/middleware/auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));
vi.mock("@server/crud/agent", () => ({
  createSession: mocks.createSession,
  listSessions: vi.fn(),
  getSession: mocks.getSession,
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  createMessage: vi.fn(),
  listMessages: vi.fn(),
  touchSession: vi.fn(),
}));
vi.mock("@server/services/agent/completion", () => ({
  runCompletion: mocks.runCompletion,
  runCompletionStream: mocks.runCompletionStream,
}));

import { router } from "./agent";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateRequest.mockResolvedValue({ user: { id: 1 } });
});

describe("Agent 请求校验", () => {
  it("无效创建会话载荷返回 422，而不是把 ZodError 当 500", async () => {
    const response = await router.request("/api/agent/sessions", {
      method: "POST",
      body: JSON.stringify({ title: 123 }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "common.invalid_request" });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("无效流式载荷返回 422，不创建 SSE 响应", async () => {
    mocks.getSession.mockResolvedValue({ id: 1, userId: 1 });
    const response = await router.request("/api/agent/sessions/1/stream", {
      method: "POST",
      body: JSON.stringify({ refImages: "not-an-array" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "common.invalid_request" });
    expect(mocks.runCompletionStream).not.toHaveBeenCalled();
  });


  it("项目缺失或不归属当前用户时返回 404", async () => {
    mocks.createSession.mockResolvedValue(null);
    const response = await router.request("/api/agent/sessions", {
      method: "POST",
      body: JSON.stringify({ projectId: "missing" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "canvas.project_not_found" });
  });
});

describe("Agent 响应契约", () => {
  it("成功响应统一使用 { code, data, msg } envelope，不再返回裸 JSON", async () => {
    mocks.createSession.mockResolvedValue({ id: 1, title: "New Chat" });
    const response = await router.request("/api/agent/sessions", {
      method: "POST",
      body: JSON.stringify({ title: "New Chat" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ code: 200, data: { id: 1, title: "New Chat" }, msg: "success" });
  });
});
