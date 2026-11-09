/**
 * useFileDrop 生产 hook 的路由测试。
 *
 * 只验证 hook 自身的落点判定与分流（文件 → 上传管道、资产 → 回调、参考拖拽忽略、
 * 空列表 / 忽略目标不触发）；文件 → 节点的网格排布由 create-nodes-from-files 的
 * 单元测试覆盖，避免在此复制生产实现。
 */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { DragEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ASSET_DRAG_TYPE } from "@/entities/asset";
import { useFileDrop } from "@/features/canvas/hooks/use-file-drop";

const mocks = vi.hoisted(() => ({
  createNodesFromFiles: vi.fn(),
}));

vi.mock("@/features/canvas/upload", () => ({
  createNodesFromFiles: (...args: unknown[]) => mocks.createNodesFromFiles(...args),
}));

type DataTransferLike = {
  types: string[];
  files: File[];
  dropEffect: string;
  getData: (type: string) => string;
};

function makeDataTransfer(opts: {
  types?: string[];
  files?: File[];
  data?: Record<string, string>;
} = {}): DataTransferLike {
  return {
    types: opts.types ?? [],
    files: opts.files ?? [],
    dropEffect: "none",
    getData: (type) => opts.data?.[type] ?? "",
  };
}

function makeEvent(
  dataTransfer: DataTransferLike | null,
  target: EventTarget | null = null,
  clientX = 120,
  clientY = 80,
): DragEvent {
  return {
    preventDefault: vi.fn(),
    target: target ?? { closest: () => null },
    dataTransfer,
    clientX,
    clientY,
  } as unknown as DragEvent;
}

function file(name: string, type: string): File {
  return new File(["x"], name, { type });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createNodesFromFiles.mockResolvedValue(undefined);
});

describe("useFileDrop（生产 hook）", () => {
  it("拖入文件：按落点交给 createNodesFromFiles，不走资产回调", async () => {
    const screenToFlowPosition = vi.fn(() => ({ x: 10, y: 20 }));
    const onAssetDrop = vi.fn();
    const { result } = renderHook(() => useFileDrop(screenToFlowPosition, undefined, undefined, onAssetDrop));

    const files = [file("a.png", "image/png"), file("b.mp4", "video/mp4")];
    await act(async () => {
      await result.current.handleDrop(makeEvent(makeDataTransfer({ types: ["Files"], files })));
    });

    expect(screenToFlowPosition).toHaveBeenCalledWith({ x: 120, y: 80 });
    expect(mocks.createNodesFromFiles).toHaveBeenCalledWith(files, { x: 10, y: 20 });
    expect(onAssetDrop).not.toHaveBeenCalled();
  });

  it("拖入资产：解析 ASSET_DRAG_TYPE 后调用 onAssetDrop，不触发上传", async () => {
    const pos = { x: 30, y: 40 };
    const screenToFlowPosition = vi.fn(() => pos);
    const onAssetDrop = vi.fn();
    const { result } = renderHook(() => useFileDrop(screenToFlowPosition, undefined, undefined, onAssetDrop));

    const asset = { id: "asset-1", fileKey: "user/1/a.png" };
    await act(async () => {
      await result.current.handleDrop(
        makeEvent(makeDataTransfer({ types: [ASSET_DRAG_TYPE], data: { [ASSET_DRAG_TYPE]: JSON.stringify(asset) } })),
      );
    });

    expect(onAssetDrop).toHaveBeenCalledWith(asset, pos);
    expect(mocks.createNodesFromFiles).not.toHaveBeenCalled();
  });

  it("资产数据损坏 / 缺少回调：静默丢弃，不抛错也不上传", async () => {
    const { result: withoutHandler } = renderHook(() => useFileDrop((p) => p));
    await act(async () => {
      await withoutHandler.current.handleDrop(
        makeEvent(makeDataTransfer({ types: [ASSET_DRAG_TYPE], data: { [ASSET_DRAG_TYPE]: "{bad" } })),
      );
    });
    expect(mocks.createNodesFromFiles).not.toHaveBeenCalled();

    const onAssetDrop = vi.fn();
    const { result } = renderHook(() => useFileDrop((p) => p, undefined, undefined, onAssetDrop));
    await act(async () => {
      await result.current.handleDrop(
        makeEvent(makeDataTransfer({ types: [ASSET_DRAG_TYPE], data: { [ASSET_DRAG_TYPE]: "{bad" } })),
      );
    });
    expect(onAssetDrop).not.toHaveBeenCalled();
    expect(mocks.createNodesFromFiles).not.toHaveBeenCalled();
  });

  it("参考区缩略图拖拽、空文件列表：不触发上传", async () => {
    const { result } = renderHook(() => useFileDrop((p) => p));

    await act(async () => {
      await result.current.handleDrop(
        makeEvent(makeDataTransfer({ types: ["application/x-ref-image"] })),
      );
    });
    await act(async () => {
      await result.current.handleDrop(makeEvent(makeDataTransfer({ types: ["Files"], files: [] })));
    });

    expect(mocks.createNodesFromFiles).not.toHaveBeenCalled();
  });

  it("忽略目标（资产弹窗 / 抽屉）：drop 与 dragover 都不处理", async () => {
    const blocked = { closest: () => ({}) } as unknown as HTMLElement;
    const { result } = renderHook(() => useFileDrop((p) => p, (target) => target === blocked));

    await act(async () => {
      await result.current.handleDrop(makeEvent(makeDataTransfer({ types: ["Files"], files: [file("a.png", "image/png")] }), blocked));
    });
    expect(mocks.createNodesFromFiles).not.toHaveBeenCalled();

    const over = makeEvent(makeDataTransfer({ types: ["Files"], files: [file("a.png", "image/png")] }), blocked);
    act(() => { result.current.handleDragOver(over); });
    expect(over.preventDefault).not.toHaveBeenCalled();
  });

  it("dragover 分流：文件接受并显示遮罩，资产接受，参考 / 非文件拒绝但不显示遮罩", () => {
    const { result } = renderHook(() => useFileDrop((p) => p));

    const filesOver = makeEvent(makeDataTransfer({ types: ["Files"] }));
    act(() => { result.current.handleDragOver(filesOver); });
    expect(filesOver.preventDefault).toHaveBeenCalled();
    expect(filesOver.dataTransfer!.dropEffect).toBe("copy");
    expect(result.current.isFileDragging).toBe(true);

    const assetOver = makeEvent(makeDataTransfer({ types: [ASSET_DRAG_TYPE] }));
    act(() => { result.current.handleDragOver(assetOver); });
    expect(assetOver.dataTransfer!.dropEffect).toBe("copy");

    const refOver = makeEvent(makeDataTransfer({ types: ["application/x-ref-video"] }));
    act(() => { result.current.handleDragOver(refOver); });
    expect(refOver.preventDefault).toHaveBeenCalled();
    expect(refOver.dataTransfer!.dropEffect).toBe("none");
  });

  it("dragstart 只拦截浏览器原生拖拽，放行参考拖拽与资产拖拽", () => {
    const { result } = renderHook(() => useFileDrop((p) => p));

    const native = makeEvent(makeDataTransfer({ types: ["text/plain"] }));
    act(() => { result.current.handleDragStart(native); });
    expect(native.preventDefault).toHaveBeenCalled();

    const ref = makeEvent(makeDataTransfer({ types: ["application/x-ref-audio"] }));
    act(() => { result.current.handleDragStart(ref); });
    expect(ref.preventDefault).not.toHaveBeenCalled();

    const asset = makeEvent(makeDataTransfer({ types: [ASSET_DRAG_TYPE] }));
    act(() => { result.current.handleDragStart(asset); });
    expect(asset.preventDefault).not.toHaveBeenCalled();
  });
});
