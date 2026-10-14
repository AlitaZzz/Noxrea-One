/**
 * useMediaEditTask 编排语义回归测试（jsdom + renderHook）。
 * 锁定 Spec 规则 1.6 回退边界在 Hook 层的语义：ClientUnsupportedError 切服务端
 * 兜底（回退不循环、回退时清除客户端残留百分比）、ClientUploadError 不回退
 * （错误码进 error.<code> 本地化通道）、客户端成功后中止丢弃产物、busy 互斥。
 * client-video 以真实模块引入（ClientUnsupportedError / ClientUploadError 的
 * instanceof 语义即契约本身）；通知与 i18n 打桩。
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notifyActionFailed: vi.fn(),
  notifyNodeBusy: vi.fn(),
}));

vi.mock("@/features/canvas/shared/notify", () => ({
  notifyActionFailed: mocks.notifyActionFailed,
  notifyNodeBusy: mocks.notifyNodeBusy,
}));
vi.mock("@/components/ui/use-app-feedback", () => ({
  useAppFeedback: () => ({ notification: { error: vi.fn(), success: vi.fn() } }),
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

import {
  ClientUnsupportedError,
  ClientUploadError,
} from "@/features/canvas/editing/client-media/client-video";
import { useMediaEditTask } from "@/features/canvas/editing/use-media-edit-task";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

const NODE_ID = "node-1";

function renderTask() {
  return renderHook(() => useMediaEditTask(NODE_ID));
}

/** 任务参数的最小形状：clientTask 返回字符串产物 */
function taskOpts(overrides: Partial<Parameters<ReturnType<typeof useMediaEditTask>["runEditTask"]>[0]> = {}) {
  return {
    kind: "clip",
    clientTask: vi.fn(async () => "client"),
    serverTask: vi.fn(async () => "server"),
    onSuccess: vi.fn(),
    errorKey: "error.clip.extract_failed",
    logLabel: "Test task failed:",
    ...overrides,
  } as Parameters<ReturnType<typeof useMediaEditTask>["runEditTask"]>[0];
}

describe("useMediaEditTask 编排语义", () => {
  beforeEach(() => {
    mocks.notifyActionFailed.mockClear();
    mocks.notifyNodeBusy.mockClear();
  });

  it("客户端成功：直接 onSuccess，服务端兜底不触发，busy 复位", async () => {
    const { result } = renderTask();
    const opts = taskOpts();
    await act(async () => {
      await result.current.runEditTask(opts);
    });
    expect(opts.clientTask).toHaveBeenCalledTimes(1);
    expect(opts.serverTask).not.toHaveBeenCalled();
    expect(opts.onSuccess).toHaveBeenCalledWith("client");
    expect(result.current.busy).toBeNull();
  });

  it("ClientUnsupportedError → 服务端兜底（回退不循环），回退时清除客户端残留百分比", async () => {
    const { result } = renderTask();
    let resolveServer!: (v: string) => void;
    const serverTask = vi.fn(
      () => new Promise<string>((resolve) => { resolveServer = resolve; }),
    );
    const opts = taskOpts({
      clientTask: vi.fn(async ({ onProgress }) => {
        onProgress(50);
        throw new ClientUnsupportedError("探测失败");
      }),
      serverTask,
    });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.runEditTask(opts);
    });
    // 兜底进行中：busy 未复位且过期百分比已清除（serverTask 不上报进度）
    await waitFor(() => {
      expect(result.current.busy).not.toBeNull();
      expect(result.current.busy?.progress).toBeUndefined();
    });
    await act(async () => {
      resolveServer("server");
      await pending;
    });
    expect(opts.clientTask).toHaveBeenCalledTimes(1);
    expect(serverTask).toHaveBeenCalledTimes(1);
    expect(opts.onSuccess).toHaveBeenCalledWith("server");
    expect(result.current.busy).toBeNull();
  });

  it("ClientUploadError → 不回退服务端，错误码进 error.<code> 本地化通道", async () => {
    const { result } = renderTask();
    const opts = taskOpts({
      clientTask: vi.fn(async () => {
        throw new ClientUploadError("upload.file_too_large", { code: "upload.file_too_large" });
      }),
    });
    await act(async () => {
      await result.current.runEditTask(opts);
    });
    expect(opts.serverTask).not.toHaveBeenCalled();
    expect(opts.onSuccess).not.toHaveBeenCalled();
    expect(mocks.notifyActionFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      "upload.file_too_large",
      "error.clip.extract_failed",
      NODE_ID,
    );
    expect(result.current.busy).toBeNull();
  });

  it("意外异常 → 不回退、无错误码、统一失败提示", async () => {
    const { result } = renderTask();
    const opts = taskOpts({
      clientTask: vi.fn(async () => {
        throw new TypeError("boom");
      }),
    });
    await act(async () => {
      await result.current.runEditTask(opts);
    });
    expect(opts.serverTask).not.toHaveBeenCalled();
    expect(mocks.notifyActionFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      undefined,
      "error.clip.extract_failed",
      NODE_ID,
    );
    expect(result.current.busy).toBeNull();
  });

  it("客户端成功但已取消：产物丢弃，不写 onSuccess、不弹失败提示", async () => {
    const { result } = renderTask();
    const opts = taskOpts({
      clientTask: vi.fn(async () => {
        result.current.cancelActive();
        return "client";
      }),
    });
    await act(async () => {
      await result.current.runEditTask(opts);
    });
    expect(opts.serverTask).not.toHaveBeenCalled();
    expect(opts.onSuccess).not.toHaveBeenCalled();
    expect(mocks.notifyActionFailed).not.toHaveBeenCalled();
    expect(result.current.busy).toBeNull();
  });

  it("任务进行中重复触发：notifyNodeBusy 拒绝且第二次不执行", async () => {
    const { result } = renderTask();
    let release!: (v: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.runEditTask(taskOpts({ clientTask: vi.fn(() => gate) }));
    });
    await waitFor(() => expect(result.current.busy).not.toBeNull());

    const secondClient = vi.fn(async () => "second");
    await act(async () => {
      await result.current.runEditTask(taskOpts({ clientTask: secondClient }));
    });
    expect(mocks.notifyNodeBusy).toHaveBeenCalledTimes(1);
    expect(secondClient).not.toHaveBeenCalled();

    await act(async () => {
      release("client");
      await pending;
    });
    expect(result.current.busy).toBeNull();
  });

  it("纯服务端任务（无 clientTask）：无取消入口，成功后 busy 复位", async () => {
    const { result } = renderTask();
    const opts = taskOpts({ clientTask: undefined });
    await act(async () => {
      await result.current.runEditTask(opts);
    });
    expect(opts.serverTask).toHaveBeenCalledTimes(1);
    expect(opts.onSuccess).toHaveBeenCalledWith("server");
    expect(result.current.busy).toBeNull();
  });
});

describe("useMediaEditTask.expectSource 源一致性守卫", () => {
  const SRC = "/api/files/a.mp4";

  afterEach(() => {
    useCanvasStore.setState({ nodes: [] });
  });

  it("节点源与期望一致 → true；节点已换源 → false", () => {
    useCanvasStore.setState({
      nodes: [{ id: NODE_ID, type: NODE_TYPE.VIDEO, data: { src: SRC } }] as unknown as AnyNode[],
    });
    const { result } = renderTask();
    expect(result.current.expectSource(SRC)).toBe(true);
    expect(result.current.expectSource("/api/files/old.mp4")).toBe(false);
  });

  it("节点已被删除 → false 且不抛错（旧源产物不得写入已不存在的节点）", () => {
    useCanvasStore.setState({ nodes: [] });
    const { result } = renderTask();
    expect(() => result.current.expectSource(SRC)).not.toThrow();
    expect(result.current.expectSource(SRC)).toBe(false);
  });
});
