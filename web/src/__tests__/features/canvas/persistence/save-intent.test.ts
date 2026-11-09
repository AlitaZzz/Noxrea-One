/**
 * 文档 store → 保存器的有界保存意图回归测试。
 *
 * 不导入任何注册模块：保存器在模块求值时自动订阅意图。若重新引入运行期
 * 注册表或副作用导入，本文件的写入断言会直接失败。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveManager } from "@/features/canvas/persistence/save-manager";
import {
  getCanvasProjectId,
  markDirtyUndo,
  syncLiveViewport,
  useCanvasStore,
} from "@/features/canvas/stores/canvas-store";
import type { AnyNode } from "@/features/canvas/types";

function node(id: string): AnyNode {
  return { id, type: "text-node", position: { x: 0, y: 0 }, data: {} } as unknown as AnyNode;
}

const project = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };

beforeEach(() => {
  // 桩掉保存器方法：隔离计时器与网络，订阅链保持真实
  vi.spyOn(saveManager, "markDirty").mockImplementation(() => {});
  vi.spyOn(saveManager, "markDirtyImmediate").mockImplementation(() => {});
  vi.spyOn(saveManager, "markDirtyUndo").mockImplementation(() => {});
  vi.spyOn(saveManager, "resetForProjectSwitch").mockImplementation(() => {});

  useCanvasStore.getState().restoreFromProject("p1", project);
  vi.mocked(saveManager.markDirty).mockClear();
  vi.mocked(saveManager.markDirtyImmediate).mockClear();
  vi.mocked(saveManager.resetForProjectSwitch).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("画布保存意图", () => {
  it("离散写入发 immediate，连续写入发 debounced", () => {
    useCanvasStore.getState().addNodes([node("a")]);
    expect(saveManager.markDirtyImmediate).toHaveBeenCalledTimes(1);

    useCanvasStore.getState().updateNodeData("a", { label: "A" });
    expect(saveManager.markDirty).toHaveBeenCalledTimes(1);
  });

  it("恢复项目在切换内容所有者前发出 project-restored", () => {
    let ownerAtReset: string | null = null;
    vi.mocked(saveManager.resetForProjectSwitch).mockImplementation(() => {
      ownerAtReset = getCanvasProjectId();
    });

    useCanvasStore.getState().restoreFromProject("p2", project);

    expect(saveManager.resetForProjectSwitch).toHaveBeenCalledWith({ clearExpired: true });
    // 清理必须发生在所有者切换之前：保存器看到的是上一条内容的所有者
    expect(ownerAtReset).toBe("p1");
    expect(getCanvasProjectId()).toBe("p2");
  });

  it("同项目恢复不清除过期态", () => {
    useCanvasStore.getState().restoreFromProject("p1", project);
    expect(saveManager.resetForProjectSwitch).toHaveBeenCalledWith({ clearExpired: false });
  });

  it("viewport 同步仅在值变化时发出 debounced", () => {
    syncLiveViewport({ x: 10, y: 20, zoom: 1 });
    syncLiveViewport({ x: 10, y: 20, zoom: 1 });
    expect(saveManager.markDirty).toHaveBeenCalledTimes(1);
  });

  it("撤销标记发出 undo 意图", () => {
    markDirtyUndo();
    expect(saveManager.markDirtyUndo).toHaveBeenCalledTimes(1);
  });
});
