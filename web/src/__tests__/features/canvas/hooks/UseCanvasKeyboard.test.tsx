// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useCanvasKeyboard } from "@/features/canvas/hooks/use-canvas-keyboard";
import { CanvasPortsContext } from "@/features/canvas/root/CanvasPortsContext";
import {
  buildCanvasClipboardHtml,
  CANVAS_CLIPBOARD_KIND,
  CANVAS_CLIPBOARD_VERSION,
  type CanvasClipboardPayload,
} from "@/features/canvas/shared/canvas-clipboard-format";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useSelectionStore } from "@/features/canvas/stores/selection-store";

const mocks = vi.hoisted(() => ({ readSystemClipboard: vi.fn() }));
vi.mock("@/features/canvas/shared/canvas-system-clipboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/canvas/shared/canvas-system-clipboard")>();
  return { ...actual, readSystemClipboard: mocks.readSystemClipboard };
});

vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    fitView: vi.fn(),
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
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

function clipboardPayload(label: string): CanvasClipboardPayload {
  return {
    kind: CANVAS_CLIPBOARD_KIND,
    version: CANVAS_CLIPBOARD_VERSION,
    nodes: [
      {
        id: label,
        type: "text-node",
        position: { x: 10, y: 20 },
        data: { label, content: `<p>${label}</p>`, plainText: label },
      },
    ],
    edges: [],
  };
}

function pasteEvent(target: EventTarget, values: Record<string, string>): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => values[type] ?? "", items: [] },
  });
  target.dispatchEvent(event);
  return event as ClipboardEvent;
}

function resetCanvas(): void {
  useCanvasStore.setState({
    ...useCanvasStore.getInitialState(),
    nodes: [],
    edges: [],
  });
}

beforeEach(() => {
  useCanvasStore.setState({
    ...useCanvasStore.getInitialState(),
    nodes: [{ id: "selected", type: "text-node", position: { x: 0, y: 0 }, data: { label: "Text", content: "", plainText: "" }, selected: true }],
    edges: [{ id: "edge", source: "selected", target: "other", selected: true }],
  });
  useSelectionStore.setState({ clipboard: null });
  mocks.readSystemClipboard.mockReset();
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

  it("pastes marked clipboard HTML synchronously without reading the system clipboard", () => {
    resetCanvas();
    renderHook(() => useCanvasKeyboard(), { wrapper: PortsWrapper });
    const payload = clipboardPayload("Copied");

    const event = pasteEvent(window, {
      "text/html": buildCanvasClipboardHtml(payload),
    });

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.readSystemClipboard).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(useCanvasStore.getState().nodes[0].data.label).toBe("Copied");
  });

  it("falls back to clipboard.read when the paste event exposes no standard content", async () => {
    resetCanvas();
    renderHook(() => useCanvasKeyboard(), { wrapper: PortsWrapper });
    mocks.readSystemClipboard.mockResolvedValue({
      payloadJson: JSON.stringify(clipboardPayload("Async")),
      imageFiles: [],
      text: "",
    });

    const event = pasteEvent(window, {});

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(useCanvasStore.getState().nodes).toHaveLength(1));
    expect(mocks.readSystemClipboard).toHaveBeenCalledTimes(1);
    expect(useCanvasStore.getState().nodes[0].data.label).toBe("Async");
  });

  it("uses the internal clipboard when the system clipboard has no usable content", async () => {
    resetCanvas();
    useSelectionStore.getState().copySelected(
      [{ id: "internal", type: "text-node", position: { x: 0, y: 0 }, data: { label: "Internal", content: "", plainText: "" } }],
      [],
    );
    renderHook(() => useCanvasKeyboard(), { wrapper: PortsWrapper });
    mocks.readSystemClipboard.mockResolvedValue({ imageFiles: [], text: "" });

    pasteEvent(window, {});

    await waitFor(() => expect(useCanvasStore.getState().nodes).toHaveLength(1));
    expect(useCanvasStore.getState().nodes[0].data.label).toBe("Internal");
  });

  it("leaves paste events in editable targets to the browser", () => {
    resetCanvas();
    renderHook(() => useCanvasKeyboard(), { wrapper: PortsWrapper });
    const input = document.createElement("input");
    document.body.appendChild(input);

    const event = pasteEvent(input, { "text/plain": "hello" });

    expect(event.defaultPrevented).toBe(false);
    expect(mocks.readSystemClipboard).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
    input.remove();
  });
});
