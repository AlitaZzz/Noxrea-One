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
  cancelGenerationTask: vi.fn(),
  loadMediaDimensions: vi.fn(),
}));

vi.mock("@/features/canvas/api/generation-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/canvas/api/generation-api")>();
  return {
    ...actual,
    generationApi: {
      streamGenerationTask: mocks.streamGenerationTask,
      fetchTasksStatus: mocks.fetchTasksStatus,
      cancelGenerationTask: mocks.cancelGenerationTask,
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

function deferredResponse() {
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => {
        controller.close();
      };
    },
  });
  return { response: { ok: true, body } as unknown as Response, close };
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
  it.each([undefined, "Lighting", "Multi-angle", "My renamed image"])("SSE 图像终态：回填内容和尺寸，保留标题 %s", async (label) => {
    addWatchedNode("n1", "t1", { label });
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
      expect(data.label).toBe(label);
    });
    // 异步尺寸回填（loadMediaDimensions mock 100x50）
    await waitFor(() => {
      const data = useCanvasStore.getState().nodes[0].data as Record<string, unknown>;
      expect(data.naturalWidth).toBe(100);
      expect(data.naturalHeight).toBe(50);
      expect(data.label).toBe(label);
    });
    await waitFor(() => expect(notif.success).toHaveBeenCalledTimes(1));
    expect(notif.success).toHaveBeenCalledWith(expect.objectContaining({ key: "generation-result-n1-t1" }));
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

  /**
   * GEN-02 生成任务生命周期语义锁定（2026-09 定案，语义说明见
   * use-sse-task-monitor scanAndConnect 处注释）：
   * 删除节点只断开本地 SSE 流，绝不取消任务；撤销复活后 monitor 重连续跑。
   * 此组测试防止未来按「删除即取消」的旧审计思路回归。
   */
  describe("GEN-02 语义锁定：删除节点不取消任务", () => {
    it("删除生成中节点：下一次扫描只断开本地流，绝不调用 cancelGenerationTask", async () => {
      addWatchedNode("n1", "t1");
      // 永不返回的流（连接挂起中），signal 是唯一可观测的断开信号
      mocks.streamGenerationTask.mockReturnValue(new Promise<Response>(() => {}));
      renderHook(() => useSseTaskMonitor(notif));
      await waitFor(() => expect(mocks.streamGenerationTask).toHaveBeenCalledTimes(1));
      const firstSignal = mocks.streamGenerationTask.mock.calls[0][1] as AbortSignal;
      expect(firstSignal.aborted).toBe(false);

      // 模拟节点删除：键盘/Agent/组级联删除最终都表现为节点从 store 消失
      act(() => {
        useCanvasStore.setState({ nodes: [], edges: [] });
      });

      // 下一次扫描（3s 周期）应断开无消费者的本地流；任务本身不被取消
      await waitFor(() => expect(firstSignal.aborted).toBe(true), { timeout: 6000 });
      expect(mocks.cancelGenerationTask).not.toHaveBeenCalled();
    }, 15_000);

    it("删除后撤销复活：binding 随快照恢复，monitor 重连续跑，终态照常落地", async () => {
      addWatchedNode("n1", "t1");
      // 快照：撤销要恢复的节点（含 taskBinding）
      const revivedNode = { ...useCanvasStore.getState().nodes[0] };
      mocks.streamGenerationTask
        .mockResolvedValueOnce(stalledResponse())
        .mockResolvedValueOnce(
          sseResponse(terminalFrame({
            taskId: "t1", status: "completed",
            resultUrls: ["/api/files/1/cc/z.png"], resultSizes: [9],
          })),
        );
      renderHook(() => useSseTaskMonitor(notif));
      await waitFor(() => expect(mocks.streamGenerationTask).toHaveBeenCalledTimes(1));
      const firstSignal = mocks.streamGenerationTask.mock.calls[0][1] as AbortSignal;

      // 删除：只断流，不取消
      act(() => {
        useCanvasStore.setState({ nodes: [], edges: [] });
      });
      await waitFor(() => expect(firstSignal.aborted).toBe(true), { timeout: 6000 });
      expect(mocks.cancelGenerationTask).not.toHaveBeenCalled();

      // 撤销复活：节点与 binding 一起回来，monitor 按 taskId 重连并拿到终态
      act(() => {
        useCanvasStore.setState({ nodes: [revivedNode] });
      });
      await waitFor(() => expect(mocks.streamGenerationTask).toHaveBeenCalledTimes(2), { timeout: 6000 });
      await waitFor(() => {
        const data = useCanvasStore.getState().nodes[0].data as Record<string, unknown>;
        expect(data.src).toBe("/api/files/1/cc/z.png");
        expect(data.taskBinding).toBeUndefined();
      });
      expect(mocks.cancelGenerationTask).not.toHaveBeenCalled();
    }, 20_000);

    it("旧连接结束时不会摘掉同 taskId 的新连接", async () => {
      addWatchedNode("n1", "t1");
      const first = deferredResponse();
      const second = deferredResponse();
      mocks.streamGenerationTask
        .mockResolvedValueOnce(first.response)
        .mockResolvedValueOnce(second.response);

      renderHook(() => useSseTaskMonitor(notif));
      await waitFor(() => expect(mocks.streamGenerationTask).toHaveBeenCalledTimes(1));
      const firstSignal = mocks.streamGenerationTask.mock.calls[0][1] as AbortSignal;

      act(() => {
        useCanvasStore.setState({ nodes: [] });
      });
      await waitFor(() => expect(firstSignal.aborted).toBe(true), { timeout: 6_000 });

      act(() => {
        addWatchedNode("n1", "t1");
      });
      await waitFor(() => expect(mocks.streamGenerationTask).toHaveBeenCalledTimes(2), { timeout: 6_000 });

      first.close();
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      expect(mocks.streamGenerationTask).toHaveBeenCalledTimes(2);
    }, 15_000);
  });
});
