/**
 * Agent 回合撤销快照时序测试（Spec: canvas-undo-redo-integrity 规则 2）。
 *
 * 回合快照在首个工具轮「即时入栈」（先于任何工具写入），与用户回合中途的
 * 编辑入栈按时间自然交错，栈序始终单调；回合未产生任何画布变更时 popIfTop
 * 补偿弹出，不留无效撤销步。
 *
 * canvas-store / history-store / 工具执行器走真实实现（move_node 执行器经
 * skipHistory 写入），仅 mock 网络层与会话管理。
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  streamAgent: vi.fn(),
  submitToolResults: vi.fn(),
  ensureSession: vi.fn(),
}));

vi.mock("@/features/canvas/agent/api", () => ({
  agentApi: {
    streamAgent: mocks.streamAgent,
    submitToolResults: mocks.submitToolResults,
  },
}));

vi.mock("@/features/canvas/agent/hooks/use-agent-sessions", () => ({
  useAgentSessions: () => ({
    chatId: "chat-1",
    chatTitle: "",
    setChatTitle: vi.fn(),
    sessions: [],
    ensureSession: mocks.ensureSession,
    loadHistory: vi.fn(),
    loadSessions: vi.fn(),
    deleteChat: vi.fn(),
    newChat: vi.fn(),
    renameChat: vi.fn(),
  }),
}));

import { useCanvasAgentStream } from "@/features/canvas/agent/hooks/use-canvas-agent-stream";
import { undoAction } from "@/features/canvas/shared/canvas-edit-actions";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { AnyNode } from "@/features/canvas/types";

const encoder = new TextEncoder();

/** 构造 SSE 响应：逐帧下发后关闭 */
function sseResponse(frames: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return { ok: true, body } as unknown as Response;
}

/** 回合第一轮：模型给出一个 move_node 工具调用 */
const moveNodeFrame = (nodeId: string) => {
  const call = { id: "call-1", name: "move_node", args: JSON.stringify({ nodeId, x: 500, y: 500 }) };
  return [`event: done\ndata: ${JSON.stringify({ toolCalls: [call] })}\n\n`];
};

/** 续轮：无后续工具调用，回合收尾 */
const doneEmptyFrame = [`event: done\ndata: ${JSON.stringify({ toolCalls: [] })}\n\n`];

function makeNode(id: string): AnyNode {
  return {
    id,
    type: "image-node",
    position: { x: 0, y: 0 },
    data: { label: id },
    style: { width: 300, height: 240 },
  } as unknown as AnyNode;
}

function nodeOf(id: string): AnyNode | undefined {
  return useCanvasStore.getState().nodes.find((n) => n.id === id);
}

beforeEach(() => {
  vi.clearAllMocks();
  useHistoryStore.getState().clear();
  useCanvasStore.setState({ nodes: [], edges: [] });
  mocks.ensureSession.mockResolvedValue("sess-1");
});

describe("Agent 回合撤销快照时序", () => {
  it("回合快照即时入栈且在用户中途编辑之下：撤销先回退用户编辑、再整撤回合", async () => {
    useCanvasStore.setState({ nodes: [makeNode("n1")], edges: [] });

    // 续轮请求发出前注入用户中途编辑（真实时序：工具已执行、模型还在续轮）
    mocks.submitToolResults.mockImplementation(async () => {
      useCanvasStore.getState().addNodes([makeNode("user-node")], { forceHistory: true });
      return sseResponse(doneEmptyFrame);
    });
    mocks.streamAgent.mockResolvedValue(sseResponse(moveNodeFrame("n1")));

    const { result } = renderHook(() => useCanvasAgentStream("model", "p1", "prov"));
    await act(async () => {
      await result.current.sendChat("把 n1 挪到 500,500");
    });

    // 工具已执行（skipHistory 不压栈）：n1 移动、user-node 存在
    expect(nodeOf("n1")!.position).toEqual({ x: 500, y: 500 });
    expect(nodeOf("user-node")).toBeDefined();

    // 恰好两条：回合快照（先）+ 用户中途编辑快照（后），执行器写入零压栈
    const stack = useHistoryStore.getState().undoStack;
    expect(stack.length).toBe(2);
    // 栈底是回合快照：回合开始前的状态（n1 在原位、无 user-node）
    expect(stack[0].nodes.find((n) => n.id === "n1")!.position).toEqual({ x: 0, y: 0 });
    expect(stack[0].nodes.some((n) => n.id === "user-node")).toBe(false);
    // 其上是用户编辑快照：n1 已移动、user-node 尚未加入
    expect(stack[1].nodes.find((n) => n.id === "n1")!.position).toEqual({ x: 500, y: 500 });
    expect(stack[1].nodes.some((n) => n.id === "user-node")).toBe(false);

    // 撤销逐级回退：先用户编辑、再整撤回合
    expect(undoAction()).toBe(true);
    expect(nodeOf("user-node")).toBeUndefined();
    expect(nodeOf("n1")!.position).toEqual({ x: 500, y: 500 });

    expect(undoAction()).toBe(true);
    expect(nodeOf("n1")!.position).toEqual({ x: 0, y: 0 });

    // 回合撤销记录登记（版本号取压栈时刻；用户中途编辑已使其失效）
    expect(result.current.lastTurnUndo).not.toBeNull();
    expect(result.current.lastTurnUndo!.version).not.toBe(useHistoryStore.getState().version);
  });

  it("回合未产生任何画布变更：快照补偿弹出，撤销栈不留无效步", async () => {
    useCanvasStore.setState({ nodes: [makeNode("n1")], edges: [] });

    // 工具调用缺少 nodeId：执行器返回 failed 且零变更
    mocks.streamAgent.mockResolvedValue(sseResponse(moveNodeFrame("")));
    mocks.submitToolResults.mockResolvedValue(sseResponse(doneEmptyFrame));

    const { result } = renderHook(() => useCanvasAgentStream("model", "p1", "prov"));
    await act(async () => {
      await result.current.sendChat("移动节点");
    });

    expect(useHistoryStore.getState().undoStack.length).toBe(0);
    expect(result.current.lastTurnUndo).toBeNull();
  });
});
