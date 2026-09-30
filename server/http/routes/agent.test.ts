import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  listMessages: vi.fn(),
  createMessage: vi.fn(),
  touchSession: vi.fn(),
  renameSession: vi.fn(),
  runCompletionStream: vi.fn(),
}));

vi.mock("@server/http/middleware/auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));
vi.mock("@server/crud/agent", () => ({
  createSession: mocks.createSession,
  listSessions: vi.fn(),
  getSession: mocks.getSession,
  renameSession: mocks.renameSession,
  deleteSession: vi.fn(),
  createMessage: mocks.createMessage,
  listMessages: mocks.listMessages,
  touchSession: mocks.touchSession,
}));
vi.mock("@server/services/agent/completion", () => ({
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

describe("Agent 项目绑定（R-AGENT-01 第二道防线）", () => {
  /** createSession 已绑定 pA 的项目级会话 */
  const BOUND = { id: 1, userId: 1, projectId: "pA" };

  beforeEach(() => {
    // 流式端点放行路径的最小闭环依赖
    mocks.listMessages.mockResolvedValue([]);
    mocks.createMessage.mockResolvedValue({ id: 1 });
    mocks.runCompletionStream.mockResolvedValue({ ok: true, text: "done" });
  });

  it("跨项目使用项目级会话读历史：403，不返回消息", async () => {
    mocks.getSession.mockResolvedValue(BOUND);

    const response = await router.request("/api/agent/sessions/1/messages?projectId=pB");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "agent.session_project_mismatch" });
    expect(mocks.listMessages).not.toHaveBeenCalled();
  });

  it("项目一致读历史：放行", async () => {
    mocks.getSession.mockResolvedValue(BOUND);

    const response = await router.request("/api/agent/sessions/1/messages?projectId=pA");

    expect(response.status).toBe(200);
    expect(mocks.listMessages).toHaveBeenCalledTimes(1);
  });

  it("未绑定项目的会话（projectId null）不受约束：无参数放行", async () => {
    mocks.getSession.mockResolvedValue({ id: 2, userId: 1, projectId: null });

    const response = await router.request("/api/agent/sessions/2/messages");

    expect(response.status).toBe(200);
  });

  it("跨项目使用项目级会话发起流式对话：403，不建 SSE、不落任何消息", async () => {
    mocks.getSession.mockResolvedValue(BOUND);

    const response = await router.request("/api/agent/sessions/1/stream", {
      method: "POST",
      body: JSON.stringify({ content: "hi", projectId: "pB" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: "agent.session_project_mismatch" });
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(mocks.runCompletionStream).not.toHaveBeenCalled();
  });

  it("项目一致发起流式对话：放行建流", async () => {
    mocks.getSession.mockResolvedValue(BOUND);

    const response = await router.request("/api/agent/sessions/1/stream", {
      method: "POST",
      body: JSON.stringify({ content: "hi", projectId: "pA" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    // 绑定校验通过后正常进入补全链路
    expect(mocks.runCompletionStream).toHaveBeenCalledTimes(1);
  });

  it("跨项目回传工具结果：403，工具结果不落库", async () => {
    mocks.getSession.mockResolvedValue(BOUND);

    const response = await router.request("/api/agent/sessions/1/tool-result", {
      method: "POST",
      body: JSON.stringify({ results: [{ toolCallId: "c1", result: "ok" }], projectId: "pB" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "agent.session_project_mismatch" });
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });

  it("项目一致回传工具结果：放行建流", async () => {
    mocks.getSession.mockResolvedValue(BOUND);

    const response = await router.request("/api/agent/sessions/1/tool-result", {
      method: "POST",
      body: JSON.stringify({ results: [{ toolCallId: "c1", result: "ok" }], projectId: "pA" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(mocks.runCompletionStream).toHaveBeenCalledTimes(1);
  });
});
