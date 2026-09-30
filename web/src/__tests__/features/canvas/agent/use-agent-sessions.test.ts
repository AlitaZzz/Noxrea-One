/**
 * Agent 会话 hook 回归测试（jsdom + renderHook，agentApi 全 mock）。
 * 锁定 loadHistory 的两条 UI 纯净性不变量：回复型工具的回执行不进入 UI；
 * 「内容与可视工具调用皆空」的 assistant 行（服务端为上游配对持久化的空轮）
 * 不进入 UI——否则新一轮流式期间渲染成幽灵「思考中…」气泡。
 * 以及会话身份世代围栏（R-AGENT-01/02）：跨项目 / 切会话 / 新对话后，
 * 在途异步响应必须被丢弃，绝不把旧身份的结果写进当前会话状态。
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

/** 手工控制 resolve 时机的 deferred：按真实竞态顺序驱动在途响应 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSessions.mockResolvedValue([{ id: 1, title: "s1", updatedAt: new Date().toISOString() }]);
  mocks.getSessionMessages.mockResolvedValue([]);
  mocks.createSession.mockResolvedValue({ id: 1, title: "t" });
  mocks.renameSession.mockResolvedValue(undefined);
});

/** 渲染 hook 并返回常用桩 */
function setup(overrides?: { projectId?: string; onLoadMessages?: ReturnType<typeof vi.fn> }) {
  const onLoadMessages = overrides?.onLoadMessages ?? vi.fn();
  const props = {
    onClearMessages: vi.fn(),
    onStopStream: vi.fn(),
    onLoadMessages,
    projectId: overrides?.projectId,
  };
  const rendered = renderHook((p: typeof props) => useAgentSessions(p), {
    initialProps: props,
    wrapper: AntApp,
  });
  return { ...rendered, props, onLoadMessages };
}

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

describe("会话身份世代围栏（R-AGENT-01/02）", () => {
  const A_MSG = [{ id: 1, role: "user", content: "A 的消息" }];

  it("同项目快速连点两个会话：先点的迟到响应被丢弃，不覆盖后点会话", async () => {
    const lateB = deferred<typeof A_MSG>();
    const firstC = deferred<typeof A_MSG>();
    mocks.getSessionMessages
      .mockImplementationOnce(() => lateB.promise)
      .mockImplementationOnce(() => firstC.promise);
    const { result, onLoadMessages } = setup();

    let loadB!: Promise<void>;
    let loadC!: Promise<void>;
    act(() => {
      // 发起顺序：先 B 后 C；C 的响应先返回
      loadB = result.current.loadHistory(11);
      loadC = result.current.loadHistory(22);
    });
    await act(async () => {
      firstC.resolve([{ id: 2, role: "user", content: "C 的消息" }]);
      await loadC;
    });
    expect(onLoadMessages).toHaveBeenCalledTimes(1);
    expect(result.current.chatId).toBe(22);

    // B 的响应迟到：世代已变，整体丢弃
    await act(async () => {
      lateB.resolve(A_MSG);
      await loadB;
    });
    expect(onLoadMessages).toHaveBeenCalledTimes(1);
    expect(result.current.chatId).toBe(22);
  });

  it("切项目后旧项目在途历史响应被丢弃：不污染新项目会话，门闸未 adopt 旧会话", async () => {
    const stale = deferred<typeof A_MSG>();
    mocks.getSessionMessages.mockImplementationOnce(() => stale.promise);
    const { result, props, rerender, onLoadMessages } = setup({ projectId: "pA" });

    act(() => {
      void result.current.loadHistory(11); // 项目 A 的历史在途
    });
    rerender({ ...props, projectId: "pB" }); // 切项目：effect 重置门闸
    await act(async () => {});

    await act(async () => {
      stale.resolve(A_MSG); // 迟到
    });
    expect(onLoadMessages).not.toHaveBeenCalled();
    expect(result.current.chatId).toBeNull();

    // 门闸未被 adopt：发送将创建项目 B 的新会话，而不是复用项目 A 的会话
    mocks.createSession.mockResolvedValue({ id: 99, title: "t" });
    let created: number | null = null;
    await act(async () => {
      created = await result.current.ensureSession("hi");
    });
    expect(created).toBe(99);
    expect(mocks.createSession).toHaveBeenCalledWith("hi", "pB");
  });

  it("newChat 后在途历史响应被丢弃：不重新灌入旧消息", async () => {
    const stale = deferred<typeof A_MSG>();
    mocks.getSessionMessages.mockImplementationOnce(() => stale.promise);
    const { result, onLoadMessages } = setup();

    act(() => {
      void result.current.loadHistory(11);
    });
    act(() => {
      result.current.newChat();
    });
    await act(async () => {
      stale.resolve(A_MSG);
    });
    expect(onLoadMessages).not.toHaveBeenCalled();
    expect(result.current.chatId).toBeNull();
  });

  it("发送（创建成功）后，更早发起的历史响应被丢弃：后发生的发送意图胜出", async () => {
    const stale = deferred<typeof A_MSG>();
    mocks.getSessionMessages.mockImplementationOnce(() => stale.promise);
    const { result, onLoadMessages } = setup();

    act(() => {
      void result.current.loadHistory(11); // 历史读取先发起
    });
    mocks.createSession.mockResolvedValue({ id: 99, title: "t" });
    await act(async () => {
      await result.current.ensureSession("hi"); // 发送后发，创建成功
    });
    expect(result.current.chatId).toBe(99);

    await act(async () => {
      stale.resolve(A_MSG); // 历史响应迟到：ensure 挂载成功已递增世代
    });
    expect(onLoadMessages).not.toHaveBeenCalled();
    expect(result.current.chatId).toBe(99);
  });

  it("世代已变的失败请求静默：不弹「加载历史失败」噪音提示", async () => {
    const stale = deferred<typeof A_MSG>();
    mocks.getSessionMessages.mockImplementationOnce(() => stale.promise);
    const { result } = setup();

    act(() => {
      void result.current.loadHistory(11);
    });
    act(() => {
      result.current.newChat();
    });
    // 不抛未处理拒绝即通过（catch 内按世代静默）
    await act(async () => {
      stale.reject(new Error("network gone"));
    });
    expect(result.current.chatId).toBeNull();
  });

  it("切项目后旧项目会话列表迟到响应不覆盖新项目列表（R-AGENT-02）", async () => {
    const staleList = deferred<Array<{ id: number; title: string; updatedAt: string }>>();
    mocks.listSessions.mockImplementationOnce(() => staleList.promise);
    const { result, props, rerender } = setup({ projectId: "pA" });

    act(() => {
      void result.current.loadSessions(); // 项目 A 的列表在途
    });
    rerender({ ...props, projectId: "pB" });
    await act(async () => {});

    // 新项目主动拉取正常工作
    mocks.listSessions.mockResolvedValueOnce([{ id: 5, title: "B 的会话", updatedAt: new Date().toISOString() }]);
    await act(async () => {
      await result.current.loadSessions();
    });
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0]?.id).toBe(5);
    expect(mocks.listSessions).toHaveBeenLastCalledWith("pB");

    // 旧项目列表迟到：不覆盖
    await act(async () => {
      staleList.resolve([{ id: 1, title: "A 的会话", updatedAt: new Date().toISOString() }]);
    });
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0]?.id).toBe(5);
  });
});
