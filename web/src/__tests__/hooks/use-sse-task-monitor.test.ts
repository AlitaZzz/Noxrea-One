/**
 * 生成任务监控 hook 回归测试（jsdom + renderHook，store 用真实 zustand）。
 * 锁定 T11 统一解析器接入后的行为：SSE 终态回填（图片/文本/失败）、
 * taskBinding 清除、尺寸异步二次回填、对账兜底（online 事件触发）。
 * @vitest-environment jsdom
 */
import { act,renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  streamGenerationTask: vi.fn(),
  fetchTasksStatus: vi.fn(),
  loadMediaDimensions: vi.fn(),
}));

vi.mock("@/features/canvas/api/generation-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/canvas/api/generation-api")>();
  return {
    ...actual,
    generationApi: {
      streamGenerationTask: mocks.streamGenerationTask,
      fetchTasksStatus: mocks.fetchTasksStatus,
    },
  };
});
vi.mock("@/lib/utils/image-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils/image-utils")>();
  return {
    ...actual,
    loadMediaDimensions: mocks.loadMediaDimensions,
  };
});
vi.mock("@/features/project/save-manager", () => ({
  saveManager: { markDirty: vi.fn(), markDirtyImmediate: vi.fn() },
}));

import type { TaskStatusEvent } from "@/features/canvas/api/generation-api";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import { useSseTaskMonitor } from "@/hooks/use-sse-task-monitor";

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

/** 永不产出数据的挂起流（模拟 SSE 连接挂死，只走对账路径） */
function stalledResponse() {
  const body = new ReadableStream<Uint8Array>({ start() {} });
  return { ok: true, body } as unknown as Response;
}

const terminalFrame = (evt: TaskStatusEvent) =>
  [`event: status\ndata: ${JSON.stringify({ type: "status", ...evt })}\n\n`];

function addWatchedNode(nodeId: string, taskId: string, extra: Record<string, unknown> = {}) {
  useCanvasStore.setState({
    nodes: [
      {
        id: nodeId,
        type: "image-node",
        position: { x: 0, y: 0 },
        data: { taskBinding: { taskId, status: "processing" }, ...extra },
      },
    ] as never,
  });
}

const notif = { success: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  useCanvasStore.setState({ nodes: [], edges: [] });
  useHistoryStore.getState().clear();
  mocks.loadMediaDimensions.mockResolvedValue({ w: 100, h: 50 });
});

afterEach(() => {
  useCanvasStore.setState({ nodes: [], edges: [] });
});

describe("useSseTaskMonitor", () => {
  it("SSE 图像终态：回填 src/fileSize、清除 taskBinding、异步补尺寸、成功通知一次", async () => {
    addWatchedNode("n1", "t1");
    mocks.streamGenerationTask.mockResolvedValue(
      sseResponse(terminalFrame({
        taskId: "t1", status: "completed",
        resultUrls: ["/api/files/1/aa/x.png"], resultSizes: [123], prompt: "pp",
      })),
    );

    renderHook(() => useSseTaskMonitor(notif));

    await waitFor(() => {
      const data = useCanvasStore.getState().nodes[0].data as Record<string, unknown>;
      expect(data.src).toBe("/api/files/1/aa/x.png");
      expect(data.taskBinding).toBeUndefined();
      expect(data.fileSize).toBe(123);
    });
    // 异步尺寸回填（loadMediaDimensions mock 100x50）
    await waitFor(() => {
      const data = useCanvasStore.getState().nodes[0].data as Record<string, unknown>;
      expect(data.naturalWidth).toBe(100);
      expect(data.naturalHeight).toBe(50);
    });
    await waitFor(() => expect(notif.success).toHaveBeenCalledTimes(1));
    expect(notif.error).not.toHaveBeenCalled();
    // 终态回填走 skipHistory：不产生撤销历史
    expect(useHistoryStore.getState().undoStack.length).toBe(0);
  });

  it("SSE 文本终态：resultText 经 textToTiptapHtml 回填 content", async () => {
    useCanvasStore.setState({
      nodes: [
        {
          id: "t-node", type: "text-node", position: { x: 0, y: 0 },
          data: { taskBinding: { taskId: "t2", status: "pending" } },
        },
      ] as never,
    });
    mocks.streamGenerationTask.mockResolvedValue(
      sseResponse(terminalFrame({
        taskId: "t2", status: "completed", resultText: "你好\n世界",
      })),
    );

    renderHook(() => useSseTaskMonitor(notif));

    await waitFor(() => {
      const data = useCanvasStore.getState().nodes[0].data as Record<string, unknown>;
      expect(data.content).toBe("<p>你好<br>世界</p>");
      expect(data.plainText).toBe("你好\n世界");
      expect(data.taskBinding).toBeUndefined();
    });
  });

  it("SSE 失败终态：清 taskBinding 并走 error 通知", async () => {
    addWatchedNode("n2", "t3");
    mocks.streamGenerationTask.mockResolvedValue(
      sseResponse(terminalFrame({
        taskId: "t3", status: "failed",
        error: "boom", errorCode: "generation.timeout",
      })),
    );

    renderHook(() => useSseTaskMonitor(notif));

    await waitFor(() => {
      const data = useCanvasStore.getState().nodes[0].data as Record<string, unknown>;
      expect(data.taskBinding).toBeUndefined();
    });
    await waitFor(() => expect(notif.error).toHaveBeenCalledTimes(1));
    expect(notif.success).not.toHaveBeenCalled();
    // 失败清理路径同样 skipHistory：不产生撤销历史
    expect(useHistoryStore.getState().undoStack.length).toBe(0);
  });

  it("对账兜底：SSE 挂死时 online 事件按 DB 状态回填", async () => {
    addWatchedNode("n3", "t4");
    mocks.streamGenerationTask.mockResolvedValue(stalledResponse());
    mocks.fetchTasksStatus.mockResolvedValue([
      { type: "status", taskId: "t4", status: "completed", resultUrls: ["/api/files/1/bb/y.png"] },
    ]);

    renderHook(() => useSseTaskMonitor(notif));
    // 首次扫描已建立挂起的 SSE；网络恢复触发对账
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => {
      const data = useCanvasStore.getState().nodes[0].data as Record<string, unknown>;
      expect(data.src).toBe("/api/files/1/bb/y.png");
      expect(data.taskBinding).toBeUndefined();
    });
    expect(mocks.fetchTasksStatus).toHaveBeenCalledWith(["t4"]);
  });

  it("对照：forceHistory 写入确实产生撤销历史（证明上方断言非空转）", () => {
    useCanvasStore.setState({
      nodes: [{ id: "c1", type: "text-node", position: { x: 0, y: 0 }, data: {} }] as never,
    });
    expect(useHistoryStore.getState().undoStack.length).toBe(0);
    useCanvasStore.getState().updateNodeData("c1", { content: "x" }, undefined, { forceHistory: true });
    expect(useHistoryStore.getState().undoStack.length).toBe(1);
  });
});
