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
