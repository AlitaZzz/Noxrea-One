/**
 * CanvasRoot 公共契约的运行时校验：
 * - ports 经 Context 正常注入，缺失 Provider 时 fail-closed；
 * - assetBrowser / assetsDialog 插槽被调用且收到声明参数；
 * - assetsDialog 引用变化不进入 CanvasSurface，userMenu 变化才触发重渲染。
 */
// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { type ReactNode, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  surface: vi.fn(),
  addNodes: vi.fn(),
}));

vi.mock("@/features/canvas/root/CanvasSurface", async () => {
  const { memo } = await import("react");
  return { default: memo(mocks.surface) };
});
vi.mock("@/features/canvas/agent/components/AgentDrawer", () => ({ default: () => null }));
vi.mock("@/features/canvas/agent/Runtime", () => ({ default: () => null }));
vi.mock("@/features/canvas/explorer/CanvasExplorer", () => ({ default: () => null }));
vi.mock("@/features/canvas/shared/CanvasMediaLoadingProvider", () => ({
  default: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/features/canvas/assets/create-asset-node", () => ({ createAssetNode: vi.fn() }));
vi.mock("@/features/canvas/stores/canvas-store", () => ({
  useCanvasStore: (selector: (state: { modalOpen: boolean; addNodes: () => void }) => unknown) =>
    selector({ modalOpen: false, addNodes: mocks.addNodes }),
  findFreePosition: vi.fn(),
  getViewportCenter: () => ({ x: 0, y: 0 }),
}));

import { useCanvasPorts } from "@/features/canvas/root/CanvasPortsContext";
import CanvasRoot from "@/features/canvas/root/CanvasRoot";
import type { CanvasPorts, CanvasSlots, CanvasSurfaceSlots } from "@/features/canvas/root/contracts";

let seenPorts: CanvasPorts | null = null;

const ports: CanvasPorts = {
  onOpenAssets: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenShortcuts: vi.fn(),
  onOpenDirector: vi.fn(),
};

function makeSlots(): CanvasSlots {
  return {
    userMenu: vi.fn(() => null),
    assetBrowser: vi.fn(() => null),
    assetsDialog: vi.fn(() => null),
  };
}

/** 作为被 mock 的 CanvasSurface 实现，读取 Context 以验证端口注入。 */
function SurfaceProbe() {
  const ports = useCanvasPorts();
  useEffect(() => {
    seenPorts = ports;
  }, [ports]);
  return null;
}

function lastSurfaceSlots(): CanvasSurfaceSlots {
  const props = mocks.surface.mock.calls.at(-1)?.[0] as { slots: CanvasSurfaceSlots } | undefined;
  if (!props) throw new Error("CanvasSurface was not rendered");
  return props.slots;
}

beforeEach(() => {
  mocks.surface.mockReset();
  mocks.addNodes.mockReset();
  seenPorts = null;
  mocks.surface.mockImplementation(SurfaceProbe);
});

describe("CanvasRoot 公共契约", () => {
  it("正常注入端口，并按声明参数调用 assetBrowser / assetsDialog 插槽", () => {
    const slots = makeSlots();

    render(<CanvasRoot projectId="p1" ports={ports} slots={slots} />);

    expect(seenPorts).toBe(ports);
    expect(slots.assetBrowser).toHaveBeenCalledTimes(1);
    expect(vi.mocked(slots.assetBrowser).mock.calls[0]![0]).toEqual({
      onInsertAsset: expect.any(Function),
    });
    expect(slots.assetsDialog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(slots.assetsDialog).mock.calls[0]![0]).toEqual({
      onInsertAsset: expect.any(Function),
      onInsertAssets: expect.any(Function),
    });

    const surfaceSlots = lastSurfaceSlots();
    expect(surfaceSlots.userMenu).toBe(slots.userMenu);
    expect(surfaceSlots).not.toHaveProperty("assetBrowser");
    expect(surfaceSlots).not.toHaveProperty("assetsDialog");
  });

  it("useCanvasPorts 在 Provider 之外 fail-closed", () => {
    function Probe() {
      useCanvasPorts();
      return null;
    }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => render(<Probe />)).toThrow("useCanvasPorts must be used within CanvasRoot");

    consoleError.mockRestore();
  });

  it("assetsDialog 引用变化不触发 CanvasSurface 重渲染，userMenu 变化才触发", () => {
    const slots = makeSlots();
    const { rerender } = render(<CanvasRoot projectId="p1" ports={ports} slots={slots} />);
    const callsAfterMount = mocks.surface.mock.calls.length;

    rerender(
      <CanvasRoot
        projectId="p1"
        ports={ports}
        slots={{ ...slots, assetsDialog: vi.fn(() => null) }}
      />,
    );
    expect(mocks.surface.mock.calls.length).toBe(callsAfterMount);

    const nextUserMenu = vi.fn(() => null);
    rerender(
      <CanvasRoot
        projectId="p1"
        ports={ports}
        slots={{ ...slots, assetsDialog: vi.fn(() => null), userMenu: nextUserMenu }}
      />,
    );
    expect(mocks.surface.mock.calls.length).toBeGreaterThan(callsAfterMount);
    expect(lastSurfaceSlots().userMenu).toBe(nextUserMenu);
  });
});
