// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useCanvasKeyboard } from "@/features/canvas/hooks/use-canvas-keyboard";
import { CanvasPortsContext } from "@/features/canvas/root/CanvasPortsContext";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    fitView: vi.fn(),
    screenToFlowPosition: vi.fn(),
  }),
}));
vi.mock("@/components/ui/use-app-feedback", () => ({
  useAppFeedback: () => ({ message: { info: vi.fn() } }),
}));
vi.mock("@/features/canvas/persistence/save-manager", () => ({
  saveManager: {
    markDirty: vi.fn(),
    markDirtyImmediate: vi.fn(),
  },
}));

beforeEach(() => {
  useCanvasStore.setState({
    ...useCanvasStore.getInitialState(),
    nodes: [{ id: "selected", type: "text-node", position: { x: 0, y: 0 }, data: { label: "Text", content: "", plainText: "" }, selected: true }],
    edges: [{ id: "edge", source: "selected", target: "other", selected: true }],
  });
});
afterEach(cleanup);

// 快捷键需要页面注入的 ports（`?` 打开快捷键说明）；其余能力用 no-op 满足契约。
const ports = {
  onOpenAssets: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenShortcuts: vi.fn(),
  onOpenDirector: vi.fn(),
};

function PortsWrapper({ children }: { children: ReactNode }) {
  return <CanvasPortsContext.Provider value={ports}>{children}</CanvasPortsContext.Provider>;
}

describe("useCanvasKeyboard", () => {
  it("closes a Hover Card on Escape without clearing the canvas selection", () => {
    renderHook(() => useCanvasKeyboard(), { wrapper: PortsWrapper });
    render(
      <HoverCard defaultOpen>
        <HoverCardTrigger asChild><button type="button">Reference</button></HoverCardTrigger>
        <HoverCardContent>Preview</HoverCardContent>
      </HoverCard>,
    );
    expect(screen.getByText("Preview")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button", { name: "Reference" }), { key: "Escape" });

    expect(screen.queryByText("Preview")).not.toBeInTheDocument();
    expect(useCanvasStore.getState().nodes[0].selected).toBe(true);
    expect(useCanvasStore.getState().edges[0].selected).toBe(true);
  });

  it("leaves Delete and arrow keys already consumed by a focused control to that control", () => {
    renderHook(() => useCanvasKeyboard(), { wrapper: PortsWrapper });
    render(<button type="button" onKeyDown={(event) => event.preventDefault()}>Control</button>);
    const control = screen.getByRole("button", { name: "Control" });

    fireEvent.keyDown(control, { key: "Delete" });
    fireEvent.keyDown(control, { key: "ArrowRight" });

    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(useCanvasStore.getState().edges).toHaveLength(1);
  });

  it("still clears selection when Escape is owned by the canvas", () => {
    renderHook(() => useCanvasKeyboard(), { wrapper: PortsWrapper });
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(useCanvasStore.getState().nodes[0].selected).toBe(false);
    expect(useCanvasStore.getState().edges[0].selected).toBe(false);
  });
});
