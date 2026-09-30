/**
 * Agent 消息流 hook 回归测试（jsdom + renderHook，agentApi 全 mock）。
 * 锁定：error 事件的 errorCode 本地化（T16）、message_user 回复提升与
 * 终止轮回传（T17 结构化标志在前端的落地行为）。
 * @vitest-environment jsdom
 */
import { act,renderHook, waitFor } from "@testing-library/react";
import { App as AntApp } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  listSessions: vi.fn(),
  getSessionMessages: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  streamAgent: vi.fn(),
  submitToolResults: vi.fn(),
}));

vi.mock("@/features/canvas/agent/api", () => ({
  agentApi: {
    createSession: mocks.createSession,
    listSessions: mocks.listSessions,
    getSessionMessages: mocks.getSessionMessages,
    deleteSession: mocks.deleteSession,
    renameSession: mocks.renameSession,
    streamAgent: mocks.streamAgent,
    submitToolResults: mocks.submitToolResults,
  },
}));

import { useCanvasAgentStream } from "@/features/canvas/agent/hooks/use-canvas-agent-stream";
import i18n from "@/lib/i18n/config";

const encoder = new TextEncoder();

function sseResponse(frames: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return { ok: true, body } as unknown as Response;
}

const doneFrame = (toolCalls: unknown[]) =>
  [`event: done\ndata: ${JSON.stringify({ toolCalls })}\n\n`];

const deltaFrame = (text: string) =>
  `event: delta\ndata: ${JSON.stringify({ delta: text })}\n\n`;

const errorFrame = (msg: string) =>
  `event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`;

/** 手动决定 resolve 时机的 promise：测试用它精确编排「旧回合迟到」的时序 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 可手动控制出帧/关闭/报错的 SSE 响应。
 * mock 的 fetch 不会响应 AbortSignal，正好模拟真实世界里
 * 「abort 后旧请求的异步续体仍可能迟到」这一不受控时序。
 */
function controllableSse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: { ok: true, body } as unknown as Response,
    send: (frame: string) => controller.enqueue(encoder.encode(frame)),
    close: () => controller.close(),
  };
}

/** streamAgent/submitToolResults 每次调用返回一个手动 resolve 的 deferred */
function mockDeferredStreams(mock: ReturnType<typeof vi.fn>) {
  const defs: Array<ReturnType<typeof deferred<Response>>> = [];
  mock.mockImplementation(() => {
    const d = deferred<Response>();
    defs.push(d);
    return d.promise;
  });
  return defs;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSessions.mockResolvedValue([]);
  mocks.getSessionMessages.mockResolvedValue([]);
  mocks.renameSession.mockResolvedValue(undefined);
});

describe("useCanvasAgentStream", () => {
  it("error 事件：errorCode 走本地化文案而非上游原文（T16）", async () => {
    mocks.createSession.mockResolvedValue({ id: 7, title: "hi" });
    mocks.streamAgent.mockResolvedValue(
      sseResponse([`event: error\ndata: ${JSON.stringify({ error: "raw boom", errorCode: "agent.provider_not_found" })}\n\n`]),
    );

    const { result } = renderHook(() => useCanvasAgentStream("model-x"), { wrapper: AntApp });
    await act(async () => {
      await result.current.sendChat("hi");
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    const last = result.current.messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.error).toBe(true);
    expect(last?.content).toBe(`⚠ ${i18n.t("error.agent.provider_not_found")}`);
    expect(last?.content).not.toContain("raw boom");
  });

  it("message_user 回复提升 + 结果回传后循环终止（T17 前端落地）", async () => {
    mocks.createSession.mockResolvedValue({ id: 7, title: "hi" });
    mocks.streamAgent.mockResolvedValue(
      sseResponse(doneFrame([
        { id: "c1", name: "message_user", args: JSON.stringify({ text: "你好呀" }) },
      ])),
    );
    mocks.submitToolResults.mockResolvedValue(sseResponse(doneFrame([])));

    const { result } = renderHook(() => useCanvasAgentStream("model-x"), { wrapper: AntApp });
    await act(async () => {
      await result.current.sendChat("hi");
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));

    // 回复文本提升为 assistant content（无占位残留）
    const assistant = result.current.messages.find((m) => m.role === "assistant" && m.content);
    expect(assistant?.content).toBe("你好呀");

    // message_user 结果单独回传，且只续了一轮（第二轮无工具即终止）
    expect(mocks.submitToolResults).toHaveBeenCalledTimes(1);
    const opts = mocks.submitToolResults.mock.calls[0][0];
    const c1Result = (opts as { results: Array<{ toolCallId: string; result: string }> }).results
      .find((r) => r.toolCallId === "c1");
    expect(c1Result?.result).toBe("消息已展示给用户。");
  });
});

/**
 * AGENT-06 回合世代令牌回归测试。
 * 用真实 deferred 时序锁定：被停止的旧回合，其迟到的响应 / 错误 / finally /
 * 工具续轮一律不得修改新回合的生命周期状态（isStreaming、空占位、abortRef）。
 */
describe("useCanvasAgentStream 回合世代隔离（AGENT-06）", () => {
  /** 驱动 sendChat 走到「已发起 streamAgent 且尚未返回」的状态（不 await 整个回合） */
  async function startTurnAwaitingStream(
    result: { current: ReturnType<typeof useCanvasAgentStream> },
    text: string,
  ) {
    await act(async () => {
      void result.current.sendChat(text);
    });
  }

  it("场景A：stop → send B → A 的响应与 finally 迟到，B 的流式状态与占位不被污染", async () => {
    mocks.createSession.mockResolvedValue({ id: 7, title: "hi" });
    const defs = mockDeferredStreams(mocks.streamAgent);
    const { result } = renderHook(() => useCanvasAgentStream("model-x"), { wrapper: AntApp });

    await startTurnAwaitingStream(result, "A");
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages.some((m) => m.role === "assistant" && !m.content)).toBe(true);

    act(() => result.current.stopStream());
    expect(result.current.isStreaming).toBe(false);

    await startTurnAwaitingStream(result, "B");
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages.some((m) => m.role === "user" && m.content === "B")).toBe(true);

    // A 的响应此刻才迟到送达（真实世界 abort 后仍可能发生）
    await act(async () => {
      defs[0].resolve(controllableSse().response);
    });

    // A 的 finally 已跑过：B 仍是活跃回合，B 的空占位没有被 A 的收尾清掉
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages.some((m) => m.role === "assistant" && !m.content)).toBe(true);

    // B 正常完成
    const b = controllableSse();
    await act(async () => {
      defs[1].resolve(b.response);
    });
    await act(async () => {
      b.send(deltaFrame("B 说你好"));
      b.close();
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.messages.some((m) => m.role === "assistant" && m.content === "B 说你好")).toBe(true);
  });

  it("场景B：A 的迟到错误不得显示到 B，B 继续正常工作", async () => {
    mocks.createSession.mockResolvedValue({ id: 7, title: "hi" });
    const defs = mockDeferredStreams(mocks.streamAgent);
    const { result } = renderHook(() => useCanvasAgentStream("model-x"), { wrapper: AntApp });

    const a = controllableSse();
    await startTurnAwaitingStream(result, "A");
    await act(async () => {
      defs[0].resolve(a.response);
    });
    // A 已进入流式读取（流打开、无数据）

    act(() => result.current.stopStream());
    await startTurnAwaitingStream(result, "B");
    const bPlaceholderCount = () =>
      result.current.messages.filter((m) => m.role === "assistant" && !m.content).length;
    expect(bPlaceholderCount()).toBe(1);

    // A 的流此刻才报错：错误渲染守卫必须丢弃（catch 的世代校验）
    await act(async () => {
      a.send(errorFrame("late boom"));
    });

    expect(result.current.messages.every((m) => !m.error)).toBe(true);
    expect(result.current.messages.some((m) => m.content?.includes("⚠"))).toBe(false);
    expect(bPlaceholderCount()).toBe(1);
    expect(result.current.isStreaming).toBe(true);

    const b = controllableSse();
    await act(async () => {
      defs[1].resolve(b.response);
    });
    await act(async () => {
      b.send(deltaFrame("B 完成"));
      b.close();
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.messages.some((m) => m.content === "B 完成")).toBe(true);
  });

  it("场景B'：A 的请求 promise 迟到 reject（非流内错误）同样不得显示到 B", async () => {
    mocks.createSession.mockResolvedValue({ id: 7, title: "hi" });
    const defs = mockDeferredStreams(mocks.streamAgent);
    const { result } = renderHook(() => useCanvasAgentStream("model-x"), { wrapper: AntApp });

    await startTurnAwaitingStream(result, "A");

    act(() => result.current.stopStream());
    await startTurnAwaitingStream(result, "B");

    // A 的请求此刻才以非 Abort 错误拒绝：catch 的世代校验必须丢弃
    await act(async () => {
      defs[0].reject(new Error("late rejection"));
    });

    expect(result.current.messages.every((m) => !m.error)).toBe(true);
    expect(result.current.messages.some((m) => m.content?.includes("⚠"))).toBe(false);
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages.some((m) => m.role === "assistant" && !m.content)).toBe(true);

    const b = controllableSse();
    await act(async () => {
      defs[1].resolve(b.response);
    });
    await act(async () => {
      b.send(deltaFrame("B 完成"));
      b.close();
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.messages.some((m) => m.content === "B 完成")).toBe(true);
  });

  it("场景C：B 完成后 A 的 finally 才进入，B 的最终状态零变化且无残留锁", async () => {
    mocks.createSession.mockResolvedValue({ id: 7, title: "hi" });
    const defs = mockDeferredStreams(mocks.streamAgent);
    const { result } = renderHook(() => useCanvasAgentStream("model-x"), { wrapper: AntApp });

    await startTurnAwaitingStream(result, "A");
    act(() => result.current.stopStream());
    await startTurnAwaitingStream(result, "B");

    // B 先完整跑完（自己的 finally 正常收尾）
    const b = controllableSse();
    await act(async () => {
      defs[1].resolve(b.response);
    });
    await act(async () => {
      b.send(deltaFrame("B text"));
      b.close();
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    const snapshot = result.current.messages;

    // A 的响应此刻才迟到
    await act(async () => {
      defs[0].resolve(controllableSse().response);
    });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.messages).toEqual(snapshot);

    // 无残留锁：第三个回合可以正常发起并完成
    await startTurnAwaitingStream(result, "C");
    const c = controllableSse();
    await act(async () => {
      defs[2].resolve(c.response);
    });
    await act(async () => {
      c.send(deltaFrame("C text"));
      c.close();
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.messages.some((m) => m.content === "C text")).toBe(true);
  });

  it("场景D：工具续轮中 stop → B 启动 → A 的迟到续轮不得复活，abortRef 仍归 B", async () => {
    mocks.createSession.mockResolvedValue({ id: 7, title: "hi" });
    const streamDefs = mockDeferredStreams(mocks.streamAgent);
    const toolDefs = mockDeferredStreams(mocks.submitToolResults);
    const { result } = renderHook(() => useCanvasAgentStream("model-x"), { wrapper: AntApp });

    // A round1：message_user 工具 → 回传 submitToolResults（挂起）
    await act(async () => {
      void result.current.sendChat("A");
    });
    const a = controllableSse();
    await act(async () => {
      streamDefs[0].resolve(a.response);
    });
    await act(async () => {
      a.send(doneFrame([{ id: "c1", name: "message_user", args: JSON.stringify({ text: "m" }) }])[0]);
      a.close();
    });
    await waitFor(() => expect(mocks.submitToolResults).toHaveBeenCalledTimes(1));

    act(() => result.current.stopStream());
    await startTurnAwaitingStream(result, "B");
    expect(result.current.isStreaming).toBe(true);
    const bSignal = (mocks.streamAgent.mock.calls[1][0] as { signal: AbortSignal }).signal;
    expect(bSignal.aborted).toBe(false);

    // A 的续轮响应此刻才迟到：A 必须在续轮守卫处退出——
    // 不复活（不再发起任何请求）、不覆写 abortRef、不清理 B 的占位
    await act(async () => {
      toolDefs[0].resolve(controllableSse().response);
    });
    expect(mocks.submitToolResults).toHaveBeenCalledTimes(1);
    expect(mocks.streamAgent).toHaveBeenCalledTimes(2);
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages.some((m) => m.role === "assistant" && !m.content)).toBe(true);
    expect(bSignal.aborted).toBe(false);

    // B 正常完成；再点停止命中的仍是 B 的控制器（abortRef 未被 A 劫持）
    const b = controllableSse();
    await act(async () => {
      streamDefs[1].resolve(b.response);
    });
    await act(async () => {
      b.send(deltaFrame("B done"));
      b.close();
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    act(() => result.current.stopStream());
    expect(bSignal.aborted).toBe(true);
  });

  it("newChat 使在途回合失格：旧回合迟到响应不得污染后续对话", async () => {
    mocks.createSession.mockResolvedValue({ id: 7, title: "hi" });
    const defs = mockDeferredStreams(mocks.streamAgent);
    const { result } = renderHook(() => useCanvasAgentStream("model-x"), { wrapper: AntApp });

    await startTurnAwaitingStream(result, "A");
    act(() => result.current.newChat());
    expect(result.current.messages).toEqual([]);
    expect(result.current.isStreaming).toBe(false);

    await startTurnAwaitingStream(result, "B");
    expect(result.current.isStreaming).toBe(true);

    await act(async () => {
      defs[0].resolve(controllableSse().response);
    });
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages.some((m) => m.role === "assistant" && !m.content)).toBe(true);

    const b = controllableSse();
    await act(async () => {
      defs[1].resolve(b.response);
    });
    await act(async () => {
      b.send(deltaFrame("B text"));
      b.close();
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.messages.some((m) => m.content === "B text")).toBe(true);
  });

  it("重入守卫：流式进行中再次 sendChat 不开启第二个回合", async () => {
    mocks.createSession.mockResolvedValue({ id: 7, title: "hi" });
    mockDeferredStreams(mocks.streamAgent);
    const { result } = renderHook(() => useCanvasAgentStream("model-x"), { wrapper: AntApp });

    await startTurnAwaitingStream(result, "A");
    await startTurnAwaitingStream(result, "B");

    expect(result.current.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(mocks.streamAgent).toHaveBeenCalledTimes(1);
  });
});
