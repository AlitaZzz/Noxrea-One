// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import TextRefChip from "@/features/canvas/shared/TextRefChip";

const { reveal, removeEdges, sourceNode } = vi.hoisted(() => ({
  reveal: vi.fn(),
  removeEdges: vi.fn(),
  sourceNode: { id: "source" },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/canvas/shared/reveal-node", () => ({
  useRevealCanvasNode: () => reveal,
}));
vi.mock("@/features/canvas/stores/canvas-store", () => ({
  useCanvasStore: {
    getState: () => ({
      nodes: [sourceNode],
      edges: [
        { id: "other-target", source: "source", target: "other" },
        { id: "reference", source: "source", target: "target" },
      ],
      removeEdges,
    }),
  },
}));

function renderChip() {
  return render(
    <TooltipProvider>
      <TextRefChip id="source" nodeId="target" content={"First line\nSecond line"} />
    </TooltipProvider>,
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("TextRefChip", () => {
  it("keeps the full-text preview open when moving from the trigger into the content", async () => {
    renderChip();
    const trigger = screen.getByRole("img", { name: "node.text" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await act(() => vi.advanceTimersByTimeAsync(700));

    const content = document.querySelector<HTMLElement>("[data-slot='hover-card-content']")!;
    expect(content.textContent).toBe("First line\nSecond line");
    expect(content.closest("[role='tooltip']")).toBeNull();
    expect(document.body).toContainElement(content);

    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    fireEvent.pointerEnter(content, { pointerType: "mouse" });
    await act(() => vi.advanceTimersByTimeAsync(350));
    expect(content).toBeInTheDocument();

    fireEvent.pointerLeave(content, { pointerType: "mouse" });
    await act(() => vi.advanceTimersByTimeAsync(350));
    expect(document.querySelector("[data-slot='hover-card-content']")).toBeNull();
  });

  it("opens on focus and dismisses on Escape", async () => {
    renderChip();
    fireEvent.focus(screen.getByRole("img", { name: "node.text" }));
    await act(() => vi.advanceTimersByTimeAsync(700));
    expect(document.querySelector("[data-slot='hover-card-content']")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector("[data-slot='hover-card-content']")).toBeNull();
  });

  it("reveals the source on double click and disconnects only the current reference", () => {
    renderChip();
    const trigger = screen.getByRole("img", { name: "node.text" });
    const remove = screen.getByRole("button", { name: "common.delete" });
    expect(trigger.contains(remove)).toBe(false);

    fireEvent.doubleClick(trigger);
    expect(reveal).toHaveBeenCalledExactlyOnceWith(sourceNode);
    reveal.mockClear();

    fireEvent.click(remove);
    fireEvent.doubleClick(remove);
    expect(removeEdges).toHaveBeenCalledExactlyOnceWith(["reference"]);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("uses the shared reference badge and compact remove control without a full-card button", () => {
    renderChip();
    const trigger = screen.getByRole("img", { name: "node.text" });
    expect(trigger.tagName).toBe("DIV");
    expect(trigger).toHaveAttribute("tabindex", "0");
    expect(screen.getByText("node.text")).toHaveClass("bg-black/55", "text-white");
    expect(screen.getByRole("button", { name: "common.delete" })).toHaveClass("size-4", "bg-popover", "focus-visible:opacity-100");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
