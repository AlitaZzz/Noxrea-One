/**
 * Agent 会话 hook 回归测试（jsdom + renderHook，agentApi 全 mock）。
 * 锁定 loadHistory 的两条 UI 纯净性不变量：回复型工具的回执行不进入 UI；
 * 「内容与可视工具调用皆空」的 assistant 行（服务端为上游配对持久化的空轮）
 * 不进入 UI——否则新一轮流式期间渲染成幽灵「思考中…」气泡。
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { App as AntApp } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  listSessions: vi.fn(),
  getSessionMessages: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
}));

vi.mock("@/features/canvas/agent/api", () => ({
  agentApi: {
    createSession: mocks.createSession,
    listSessions: mocks.listSessions,
    getSessionMessages: mocks.getSessionMessages,
    deleteSession: mocks.deleteSession,
    renameSession: mocks.renameSession,
  },
}));

import { useAgentSessions } from "@/features/canvas/agent/hooks/use-agent-sessions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSessions.mockResolvedValue([{ id: 1, title: "s1", updatedAt: new Date().toISOString() }]);
  mocks.getSessionMessages.mockResolvedValue([]);
  mocks.createSession.mockResolvedValue({ id: 1, title: "t" });
  mocks.renameSession.mockResolvedValue(undefined);
});

describe("useAgentSessions.loadHistory", () => {
  it("空轮 assistant 行（无内容且无可视工具调用）被排除，不产生幽灵气泡", async () => {
    mocks.getSessionMessages.mockResolvedValue([
      // 正常用户消息
      { id: 1, role: "user", content: "hi", createdAt: new Date().toISOString() },
      // 空轮：服务端为上游配对落库的空 content 纯 message_user 轮
      {
        id: 2,
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "message_user", args: "{}", label: "回复用户" }],
        createdAt: new Date().toISOString(),
      },
      // 有内容或可视调用的 assistant 行必须保留
      {
        id: 3,
        role: "assistant",
        content: "你好",
        toolCalls: [{ id: "c2", name: "message_user", args: "{}" }],
        createdAt: new Date().toISOString(),
      },
      {
        id: 4,
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c3", name: "create_node", args: "{}", label: "创建节点" }],
        createdAt: new Date().toISOString(),
      },
    ]);

    const onLoadMessages = vi.fn();
    const { result } = renderHook(() =>
      useAgentSessions({
        onClearMessages: vi.fn(),
        onStopStream: vi.fn(),
        onLoadMessages,
        projectId: undefined,
      }),
      { wrapper: AntApp },
    );

    await act(async () => {
      await result.current.loadHistory(1);
    });

    expect(onLoadMessages).toHaveBeenCalledTimes(1);
    const loaded = onLoadMessages.mock.calls[0][0] as Array<{
      role: string;
      content?: string;
      toolCalls?: Array<{ name: string }>;
    }>;
    // 用户消息 + 有内容的 assistant + 有可视调用的 assistant 保留（3 条）
    expect(loaded).toHaveLength(3);
    // 空轮 assistant 不在其中
    expect(loaded.filter((m) => m.role === "assistant" && !m.content && !(m.toolCalls?.length))).toEqual([]);
    // 保留的 assistant 的 message_user 调用被过滤（无可视调用时不设 toolCalls 字段）、create_node 可视调用保留
    const withText = loaded.find((m) => m.content === "你好");
    expect(withText?.toolCalls).toBeUndefined();
    const withCalls = loaded.find((m) => m.toolCalls?.length);
    expect(withCalls?.toolCalls?.[0]?.name).toBe("create_node");
  });

  it("message_user 的 tool 回执行不进入 UI", async () => {
    mocks.getSessionMessages.mockResolvedValue([
      { id: 1, role: "user", content: "hi", createdAt: new Date().toISOString() },
      {
        id: 2,
        role: "assistant",
        content: "你好",
        toolCalls: [{ id: "c1", name: "message_user", args: "{}" }],
        createdAt: new Date().toISOString(),
      },
      { id: 3, role: "tool", content: "消息已展示给用户。", toolCallId: "c1", createdAt: new Date().toISOString() },
    ]);

    const onLoadMessages = vi.fn();
    const { result } = renderHook(() =>
      useAgentSessions({
        onClearMessages: vi.fn(),
        onStopStream: vi.fn(),
        onLoadMessages,
        projectId: undefined,
      }),
      { wrapper: AntApp },
    );

    await act(async () => {
      await result.current.loadHistory(1);
    });

    const loaded = onLoadMessages.mock.calls[0][0] as Array<{ role: string; toolCallId?: string }>;
    expect(loaded.filter((m) => m.role === "tool")).toEqual([]);
    expect(loaded).toHaveLength(2);
  });
});
