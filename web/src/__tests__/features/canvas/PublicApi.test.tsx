/**
 * features/canvas 公共入口的页面级契约（被测对象只经 `@/features/canvas` 导入）。
 *
 * 覆盖验收 5/10 的公开 API：prompt 目录预加载的三态、Director 桥的读写与
 * 节点删除后的 no-op 退化、会话过期只读选择器、保存 flush 包装委托。
 * 作为 canvas feature 自身用例，用内部 store / SaveManager 播种状态并断言委托。
 */
// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectorImageNodeInput, DirectorStateData } from "@/entities/director";
import {
  flushCanvasSave,
  preloadCanvasPromptTemplates,
  useDirectorBridge,
  useSessionExpired,
} from "@/features/canvas";
import { saveManager } from "@/features/canvas/persistence/save-manager";
import { useSessionExpiredStore } from "@/features/canvas/session/session-expired-store";
import type { PromptTemplateCatalog } from "@/features/canvas/shared/prompt-presets";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  createImageNodeFromRef: vi.fn(),
}));

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    api: (...args: unknown[]) => mocks.api(...args),
  };
});

vi.mock("@/features/canvas/upload/derived-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/canvas/upload/derived-node")>();
  return {
    ...actual,
    createImageNodeFromRef: (...args: unknown[]) => mocks.createImageNodeFromRef(...args),
  };
});

const CATALOG: PromptTemplateCatalog = {
  groups: [{ id: "g1", label: { zh: "分组", en: "Group" }, column: 1, order: 1 }],
  entries: [
    {
      id: "preset-1",
      kind: "preset",
      target: "image",
      group: "g1",
      label: { zh: "预设", en: "Preset" },
      description: { zh: "", en: "" },
      order: 1,
      template: "模板",
    },
  ],
};

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.createImageNodeFromRef.mockReset();
  useCanvasStore.setState({ nodes: [], edges: [] });
  useSessionExpiredStore.getState().resetExpired();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("preloadCanvasPromptTemplates", () => {
  it("刷新成功返回 true 并写入唯一目录缓存", async () => {
    mocks.api.mockResolvedValue(CATALOG);
    const queryClient = makeQueryClient();

    await expect(preloadCanvasPromptTemplates(queryClient)).resolves.toBe(true);

    expect(mocks.api).toHaveBeenCalledWith("/api/canvas/prompt-templates");
    expect(queryClient.getQueryData(["canvas", "prompt-templates", "all"])).toEqual(CATALOG);
  });

  it("无缓存且刷新失败返回 false", async () => {
    mocks.api.mockRejectedValue(new Error("offline"));
    const queryClient = makeQueryClient();

    await expect(preloadCanvasPromptTemplates(queryClient)).resolves.toBe(false);
  });

  it("刷新失败但已有缓存数据仍返回 true（短暂断网不阻塞门页）", async () => {
    mocks.api.mockResolvedValue(CATALOG);
    const queryClient = makeQueryClient();
    await preloadCanvasPromptTemplates(queryClient);

    mocks.api.mockRejectedValue(new Error("offline"));
    await expect(preloadCanvasPromptTemplates(queryClient)).resolves.toBe(true);
  });
});

describe("useDirectorBridge", () => {
  const STATE = { shots: [], entities: [] } as unknown as DirectorStateData;

  function seedDirectorNode(id = "director-1"): AnyNode {
    return {
      id,
      type: NODE_TYPE.DIRECTOR,
      position: { x: 0, y: 0 },
      data: { label: "director", directorState: STATE },
    } as AnyNode;
  }

  it("读取当前节点保存的场景快照", () => {
    useCanvasStore.setState({ nodes: [seedDirectorNode()] });
    const { result } = renderHook(() => useDirectorBridge("director-1"));

    expect(result.current.initialState).toBe(STATE);
  });

  it("onSaveState 写回节点数据；节点删除后为 no-op", () => {
    useCanvasStore.setState({ nodes: [seedDirectorNode()] });
    const { result } = renderHook(() => useDirectorBridge("director-1"));
    const next = { shots: [{ id: "s1" }] } as unknown as DirectorStateData;

    act(() => result.current.onSaveState(next));
    expect(
      (useCanvasStore.getState().nodes[0].data as { directorState?: DirectorStateData })
        .directorState,
    ).toBe(next);

    act(() => useCanvasStore.setState({ nodes: [] }));
    expect(() => result.current.onSaveState(STATE)).not.toThrow();
    expect(useCanvasStore.getState().nodes).toEqual([]);
  });

  it("onCreateImageNode 由节点身份派生出图；节点不存在时 no-op", async () => {
    useCanvasStore.setState({ nodes: [seedDirectorNode()] });
    const { result } = renderHook(() => useDirectorBridge("director-1"));
    const input: DirectorImageNodeInput = { ref: "shots/a.png", width: 640, height: 360, name: "镜头 A" };

    await act(async () => result.current.onCreateImageNode(input));

    expect(mocks.createImageNodeFromRef).toHaveBeenCalledWith({
      sourceId: "director-1",
      ref: "shots/a.png",
      naturalWidth: 640,
      naturalHeight: 360,
      labelSuffix: "镜头 A",
      storeApi: expect.anything(),
      extraNodeData: { source: "derived" },
      labelOverride: "镜头 A",
    });

    await act(() => useCanvasStore.setState({ nodes: [] }));
    mocks.createImageNodeFromRef.mockClear();
    await act(async () => result.current.onCreateImageNode(input));
    expect(mocks.createImageNodeFromRef).not.toHaveBeenCalled();
  });

  it("空节点 id：快照为 null，动作全部 no-op", async () => {
    const { result } = renderHook(() => useDirectorBridge(null));

    expect(result.current.initialState).toBeNull();
    result.current.onSaveState(STATE);
    await result.current.onCreateImageNode({ ref: "r", width: 1, height: 1, name: "n" });
    expect(mocks.createImageNodeFromRef).not.toHaveBeenCalled();
  });
});

describe("useSessionExpired", () => {
  it("只读投影会话过期状态", () => {
    const { result } = renderHook(() => useSessionExpired());
    expect(result.current).toBe(false);

    act(() => useSessionExpiredStore.getState().markExpired());
    expect(result.current).toBe(true);

    act(() => useSessionExpiredStore.getState().resetExpired());
    expect(result.current).toBe(false);
  });
});

describe("flushCanvasSave", () => {
  it("公开包装委托唯一 SaveManager 并始终 resolve", async () => {
    const spy = vi.spyOn(saveManager, "flushAndWait").mockResolvedValueOnce();

    await expect(flushCanvasSave()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
