/**
 * useGenerationSubmit 竞态回归测试（GEN-01）。
 * 用 deferred 真实驱动 await 时序：owner 失效（卸载 / 切项目 / 节点删除 /
 * 显式取消 / 新一轮生成）后迟到的 taskId 必须取消后端任务、绝不写绑定、
 * 不污染撤销栈。canvas-store / history-store 走真实实现（restoreFromProject
 * 验证项目切换、updateNodeData 验证写绑定），仅 mock 网络层与 SaveManager。
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submitGenerationTask: vi.fn(),
  cancelGenerationTask: vi.fn(),
  flushAndWait: vi.fn(),
}));

vi.mock("@/features/canvas/api/generation-api", () => ({
  generationApi: {
    submitGenerationTask: mocks.submitGenerationTask,
    cancelGenerationTask: mocks.cancelGenerationTask,
  },
}));

vi.mock("@/features/project/save-manager", () => ({
  saveManager: {
    markDirty: vi.fn(),
    markDirtyImmediate: vi.fn(),
    markDirtyUndo: vi.fn(),
    flushAndWait: mocks.flushAndWait,
    resetForProjectSwitch: vi.fn(),
  },
}));

import { type GenerationSubmitOutcome,useGenerationSubmit } from "@/features/canvas/panels/use-generation-submit";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { AnyNode } from "@/features/canvas/types";

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

/** submitGenerationTask 只消费 ok/status/json，纯对象即可，无需构造真实 Response */
function okResponse(taskId: string): Response {
  return { ok: true, status: 200, json: async () => ({ code: 200, data: { id: taskId } }) } as unknown as Response;
}

function failResponse(status: number, body: unknown): Response {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

function makeNode(id: string): AnyNode {
  return { id, type: "image-node", position: { x: 0, y: 0 }, data: {} } as unknown as AnyNode;
}

function bindingOf(nodeId: string): { taskId?: string } | undefined {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
  return (node?.data as { taskBinding?: { taskId?: string } } | undefined)?.taskBinding;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cancelGenerationTask.mockResolvedValue(undefined);
  mocks.flushAndWait.mockResolvedValue(undefined);
  useHistoryStore.getState().clear();
  // 每例重建画布：项目 pA、可生成节点 n1（restoreFromProject 是 _canvasProjectId 唯一写入口）
  useCanvasStore.getState().restoreFromProject("pA", { nodes: [makeNode("n1")] });
});

/** 发起一次提交并返回 outcome promise（在 act 内登记 runId 与请求） */
function beginSubmit(
  result: { current: ReturnType<typeof useGenerationSubmit> },
  request: () => Promise<Response>,
  nodeId = "n1"
): Promise<GenerationSubmitOutcome> {
  let promise!: Promise<GenerationSubmitOutcome>;
  act(() => {
    promise = result.current.submitWithOwner({ runId: result.current.beginRun(), nodeId, request });
  });
  return promise;
}

describe("useGenerationSubmit owner 终验通过", () => {
  it("owner 全部有效：绑定写入、预生成快照压栈、等待落盘、不取消", async () => {
    mocks.submitGenerationTask.mockResolvedValue(okResponse("task-1"));
    const { result } = renderHook(() => useGenerationSubmit());

    let outcome: GenerationSubmitOutcome | undefined;
    await act(async () => {
      const runId = result.current.beginRun();
      outcome = await result.current.submitWithOwner({ runId, nodeId: "n1", request: () => mocks.submitGenerationTask() });
    });

    expect(outcome).toEqual({ status: "submitted" });
    expect(mocks.cancelGenerationTask).not.toHaveBeenCalled();
    expect(bindingOf("n1")?.taskId).toBe("task-1");
    expect(useHistoryStore.getState().undoStack.length).toBe(1);
    expect(mocks.flushAndWait).toHaveBeenCalledTimes(1);
  });

  it("StrictMode 双挂载后提交仍然有效：alive 状态在 effect 重入后恢复", async () => {
    mocks.submitGenerationTask.mockResolvedValue(okResponse("task-1"));
    const { result } = renderHook(() => useGenerationSubmit(), { wrapper: StrictMode });

    let outcome: GenerationSubmitOutcome | undefined;
    await act(async () => {
      const runId = result.current.beginRun();
      outcome = await result.current.submitWithOwner({ runId, nodeId: "n1", request: () => mocks.submitGenerationTask() });
    });

    expect(outcome).toEqual({ status: "submitted" });
    expect(bindingOf("n1")?.taskId).toBe("task-1");
  });

  it("非 ok 响应：failed 带错误文案，不取消、不写绑定", async () => {
    mocks.submitGenerationTask.mockResolvedValue(failResponse(500, { error: "upstream boom" }));
    const { result } = renderHook(() => useGenerationSubmit());

    let outcome: GenerationSubmitOutcome | undefined;
    await act(async () => {
      const runId = result.current.beginRun();
      outcome = await result.current.submitWithOwner({ runId, nodeId: "n1", request: () => mocks.submitGenerationTask() });
    });

    expect(outcome?.status).toBe("failed");
    expect((outcome as { error?: string }).error).toBeTruthy();
    expect(mocks.cancelGenerationTask).not.toHaveBeenCalled();
    expect(bindingOf("n1")).toBeUndefined();
  });

  it("请求抛错：failed，不写绑定", async () => {
    mocks.submitGenerationTask.mockRejectedValue(new Error("network gone"));
    const { result } = renderHook(() => useGenerationSubmit());

    let outcome: GenerationSubmitOutcome | undefined;
    await act(async () => {
      const runId = result.current.beginRun();
      outcome = await result.current.submitWithOwner({ runId, nodeId: "n1", request: () => mocks.submitGenerationTask() });
    });

    expect(outcome?.status).toBe("failed");
    expect((outcome as { error?: string }).error).toContain("network gone");
    expect(bindingOf("n1")).toBeUndefined();
  });
});

describe("useGenerationSubmit owner 失效（GEN-01 竞态）", () => {
  it("submit 在途 → unmount → taskId 迟到：取消后端任务、不写绑定、撤销栈不增长", async () => {
    const late = deferred<Response>();
    mocks.submitGenerationTask.mockReturnValue(late.promise);
    const { result, unmount } = renderHook(() => useGenerationSubmit());
    const promise = beginSubmit(result, () => late.promise);
    const stackLen = useHistoryStore.getState().undoStack.length;

    unmount();
    await act(async () => {
      late.resolve(okResponse("task-late"));
      await promise;
    });

    expect(mocks.cancelGenerationTask).toHaveBeenCalledWith("task-late");
    expect(bindingOf("n1")).toBeUndefined();
    expect(useHistoryStore.getState().undoStack.length).toBe(stackLen);
  });

  it("submit 在途 → 切项目（画布换主）→ 迟到：即使新项目有同 id 节点也不写入", async () => {
    const late = deferred<Response>();
    mocks.submitGenerationTask.mockReturnValue(late.promise);
    const { result } = renderHook(() => useGenerationSubmit());
    const promise = beginSubmit(result, () => late.promise);

    // 换主到 pB，且刻意保留同 id 节点：证明拦下写入的是 projectId 校验本身
    act(() => {
      useCanvasStore.getState().restoreFromProject("pB", { nodes: [makeNode("n1")] });
    });
    await act(async () => {
      late.resolve(okResponse("task-late"));
      await promise;
    });

    expect(mocks.cancelGenerationTask).toHaveBeenCalledWith("task-late");
    expect(bindingOf("n1")).toBeUndefined();
  });

  it("submit 在途 → 节点被删除 → 迟到：取消后端任务、不写绑定、撤销栈不增长", async () => {
    const late = deferred<Response>();
    mocks.submitGenerationTask.mockReturnValue(late.promise);
    const { result } = renderHook(() => useGenerationSubmit());
    const promise = beginSubmit(result, () => late.promise);
    const stackLen = useHistoryStore.getState().undoStack.length;

    act(() => {
      useCanvasStore.setState({ nodes: [] });
    });
    await act(async () => {
      late.resolve(okResponse("task-late"));
      await promise;
    });

    expect(mocks.cancelGenerationTask).toHaveBeenCalledWith("task-late");
    expect(useCanvasStore.getState().nodes.find((n) => n.id === "n1")).toBeUndefined();
    expect(useHistoryStore.getState().undoStack.length).toBe(stackLen);
  });

  it("submit 在途 → 显式取消 → 迟到：取消后端任务、不写绑定", async () => {
    const late = deferred<Response>();
    mocks.submitGenerationTask.mockReturnValue(late.promise);
    const { result } = renderHook(() => useGenerationSubmit());
    const promise = beginSubmit(result, () => late.promise);

    act(() => {
      result.current.invalidate();
    });
    await act(async () => {
      late.resolve(okResponse("task-late"));
      await promise;
    });

    expect(mocks.cancelGenerationTask).toHaveBeenCalledWith("task-late");
    expect(bindingOf("n1")).toBeUndefined();
  });

  it("发起前已失效：不发请求", async () => {
    const { result } = renderHook(() => useGenerationSubmit());
    let runId!: number;
    act(() => {
      runId = result.current.beginRun();
    });
    act(() => {
      result.current.invalidate();
    });

    let outcome: GenerationSubmitOutcome | undefined;
    await act(async () => {
      outcome = await result.current.submitWithOwner({ runId, nodeId: "n1", request: () => mocks.submitGenerationTask() });
    });

    expect(mocks.submitGenerationTask).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "stale" });
  });

  it("旧任务在新一轮生成开始后迟到：取消旧任务、不覆盖新绑定；新任务正常写入", async () => {
    const lateOld = deferred<Response>();
    mocks.submitGenerationTask
      .mockReturnValueOnce(lateOld.promise)
      .mockResolvedValueOnce(okResponse("task-2"));
    const { result } = renderHook(() => useGenerationSubmit());

    // 两次提交都经 mock：第 1 次调用挂起（旧任务）、第 2 次立即返回（新任务）
    const oldPromise = beginSubmit(result, () => mocks.submitGenerationTask());
    const newPromise = beginSubmit(result, () => mocks.submitGenerationTask());
    await act(async () => {
      await newPromise;
    });
    expect(bindingOf("n1")?.taskId).toBe("task-2");

    await act(async () => {
      lateOld.resolve(okResponse("task-old"));
      await oldPromise;
    });

    expect(mocks.cancelGenerationTask).toHaveBeenCalledWith("task-old");
    // 旧任务不覆盖新一轮的绑定
    expect(bindingOf("n1")?.taskId).toBe("task-2");
  });
});
