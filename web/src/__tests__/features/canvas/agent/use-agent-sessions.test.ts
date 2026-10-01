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
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TestFeedbackProvider } from "@/test-utils/TestFeedbackProvider";

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
  mocks.deleteSession.mockResolvedValue(undefined);
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
    wrapper: TestFeedbackProvider,
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
      { wrapper: TestFeedbackProvider },
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
      { wrapper: TestFeedbackProvider },
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

describe("delete / rename 生命周期围栏（R-AGENT-03）", () => {
  const A_MSG = [{ id: 1, role: "user", content: "A 的消息" }];
  const LIST_A_B = [
    { id: 11, title: "A", updatedAt: new Date().toISOString() },
    { id: 22, title: "B 标题", updatedAt: new Date().toISOString() },
  ];

  it("删除会话 A 在途时切到 B：迟到响应以实时身份判定，不清空当前会话", async () => {
    const deleteA = deferred<void>();
    mocks.deleteSession.mockImplementationOnce(() => deleteA.promise);
    const { result, props } = setup();
    mocks.listSessions.mockResolvedValue(LIST_A_B);

    await act(async () => {
      await result.current.loadSessions();
    });
    await act(async () => {
      await result.current.loadHistory(11); // 当前在 A：deleteChat 闭包捕获此身份
    });
    expect(result.current.chatId).toBe(11);

    let deletePromise!: Promise<void>;
    act(() => {
      deletePromise = result.current.deleteChat(11); // DELETE 在途
    });
    await act(async () => {
      await result.current.loadHistory(22); // 删除期间切到 B
    });
    expect(result.current.chatId).toBe(22);

    await act(async () => {
      deleteA.resolve();
      await deletePromise;
    });

    // 旧实现用闭包 chatId（仍为 11）判定 → 误触发 newChat 清空 B；
    // 现以门闸实时身份（22）判定：B 的消息保留、身份保留
    expect(result.current.chatId).toBe(22);
    expect(props.onClearMessages).toHaveBeenCalledTimes(1); // 仅 mount effect 调用过
    // A 从列表移除（服务端已确认删除，函数式过滤无条件执行）
    expect(result.current.sessions.find((s) => s.id === 11)).toBeUndefined();
  });

  it("删除当前会话仍正常开新对话（回归保护），projectId 随请求传递", async () => {
    const { result, props } = setup({ projectId: "pA" });
    mocks.listSessions.mockResolvedValue(LIST_A_B);
    await act(async () => {
      await result.current.loadSessions();
    });
    await act(async () => {
      await result.current.loadHistory(11);
    });
    expect(result.current.chatId).toBe(11);

    await act(async () => {
      await result.current.deleteChat(11);
    });

    expect(result.current.chatId).toBeNull();
    // mount effect 的 onClearMessages + newChat 的 onClearMessages
    expect(props.onClearMessages).toHaveBeenCalledTimes(2);
    expect(result.current.sessions.find((s) => s.id === 11)).toBeUndefined();
    expect(mocks.deleteSession).toHaveBeenCalledWith(11, "pA");
  });

  it("重命名会话 A 在途时切到 B：迟到响应不改写 B 的标题", async () => {
    const renameA = deferred<void>();
    mocks.renameSession.mockImplementationOnce(() => renameA.promise);
    const { result } = setup();
    mocks.listSessions.mockResolvedValue(LIST_A_B);

    // 先把列表应用到 sessions state：loadHistory 的 chatTitle 从列表按 id 查找
    await act(async () => {
      await result.current.loadSessions();
    });
    await act(async () => {
      await result.current.loadHistory(11); // chatId=11、chatTitle="A"
    });
    expect(result.current.chatTitle).toBe("A");

    let renamePromise!: Promise<void>;
    act(() => {
      renamePromise = result.current.renameChat("A 的新标题");
    });
    await act(async () => {
      await result.current.loadHistory(22); // 切到 B
    });
    expect(result.current.chatTitle).toBe("B 标题");

    await act(async () => {
      renameA.resolve();
      await renamePromise;
    });

    // 迟到的重命名响应不写进已切换的 B（旧实现无条件 setChatTitle 会覆盖）
    expect(result.current.chatTitle).toBe("B 标题");
  });

  it("删除会话 A 与读取 A 历史并发：迟到的历史响应不重新挂载已删会话", async () => {
    const historyA = deferred<typeof A_MSG>();
    // 按会话 id 精确挂起：A 的历史在途，B 的正常返回
    mocks.getSessionMessages.mockImplementation((sid: number) =>
      sid === 11 ? historyA.promise : Promise.resolve([]));
    const { result, onLoadMessages } = setup();
    mocks.listSessions.mockResolvedValue(LIST_A_B);

    await act(async () => {
      await result.current.loadHistory(22); // 当前在 B
    });
    expect(result.current.chatId).toBe(22);
    expect(onLoadMessages).toHaveBeenCalledTimes(1);

    act(() => {
      void result.current.loadHistory(11); // 点开 A 的历史（在途）
    });
    await act(async () => {
      await result.current.deleteChat(11); // 删除 A：服务端确认
    });
    // 删除不（应）打断当前会话 B
    expect(result.current.chatId).toBe(22);

    await act(async () => {
      historyA.resolve(A_MSG); // A 的历史迟到
      await Promise.resolve();
    });

    // 世代未变（delete 不是身份变更）但目标已删除：不 adopt、不灌入消息
    expect(onLoadMessages).toHaveBeenCalledTimes(1);
    expect(result.current.chatId).toBe(22);
    mocks.getSessionMessages.mockRestore();
  });

  it("删除会话 A 后，更早发起的会话列表迟到响应不再复活 A", async () => {
    const staleList = deferred<Array<{ id: number; title: string; updatedAt: string }>>();
    mocks.listSessions.mockImplementationOnce(() => staleList.promise);
    const { result } = setup();

    act(() => {
      void result.current.loadSessions(); // 列表读取在途（响应含 A）
    });
    await act(async () => {
      await result.current.deleteChat(11); // 删除 A：列表世代递增 + 本地过滤
    });
    expect(result.current.sessions).toEqual([]);

    await act(async () => {
      staleList.resolve(LIST_A_B); // 删除前的服务端快照迟到（含 A）
    });

    expect(result.current.sessions.find((s) => s.id === 11)).toBeUndefined();
  });

  it("切项目后旧项目在途的删除响应不触发新对话、不碰新项目状态", async () => {
    const deleteA = deferred<void>();
    mocks.deleteSession.mockImplementationOnce(() => deleteA.promise);
    const { result, props, rerender } = setup({ projectId: "pA" });
    mocks.listSessions.mockResolvedValue(LIST_A_B);

    await act(async () => {
      await result.current.loadSessions();
    });
    await act(async () => {
      await result.current.loadHistory(11);
    });
    expect(result.current.chatId).toBe(11);

    act(() => {
      void result.current.deleteChat(11); // DELETE 在途
    });
    rerender({ ...props, projectId: "pB" }); // 切项目：门闸 reset
    await act(async () => {});
    expect(result.current.chatId).toBeNull();

    await act(async () => {
      deleteA.resolve();
      await Promise.resolve();
    });

    // 门闸 current 已被切项目清空：迟到的删除不再触发 newChat
    // （旧实现闭包 chatId===11 会误触发：onClearMessages 变三次）
    expect(result.current.chatId).toBeNull();
    // 挂载时 projectId effect + 切项目 effect 各一次；旧实现会多出 newChat 的第三次
    expect(props.onClearMessages).toHaveBeenCalledTimes(2);
  });

  it("切项目后旧项目在途的重命名响应不改写新项目标题", async () => {
    const renameA = deferred<void>();
    mocks.renameSession.mockImplementationOnce(() => renameA.promise);
    const { result, props, rerender } = setup({ projectId: "pA" });

    await act(async () => {
      await result.current.loadHistory(11);
    });
    act(() => {
      void result.current.renameChat("A 的新标题");
    });
    rerender({ ...props, projectId: "pB" });
    await act(async () => {});

    await act(async () => {
      renameA.resolve();
      await Promise.resolve();
    });

    // 切项目已把 chatTitle 重置为 null：迟到的重命名不写回
    expect(result.current.chatTitle).toBeNull();
  });
});
