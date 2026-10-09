// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import NodeToolbar from "@/features/canvas/nodes/NodeToolbar";

const { dispatchNodeAction } = vi.hoisted(() => ({ dispatchNodeAction: vi.fn() }));

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/features/assets/store", () => ({
  useAssetsStore: (selector: (state: unknown) => unknown) => selector({ knownAssetUrls: new Set(), unsaveAssetsByUrls: vi.fn() }),
}));
vi.mock("@/features/canvas/stores/canvas-store", () => ({
  useCanvasStore: (selector: (state: unknown) => unknown) => selector({ nodes: [{ id: "image-1", data: { src: "/image.png" } }] }),
}));
vi.mock("@/features/canvas/shared/node-action", () => ({ dispatchNodeAction }));
vi.mock("@/features/canvas/shared/prompt-presets", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/features/canvas/shared/prompt-presets")>(),
  usePromptTemplateCatalog: () => ({ data: {
    groups: [{ id: "views", label: { en: "Views", zh: "Views" }, column: 1, order: 1 }],
    entries: [{ id: "characterThreeView", group: "views", label: { en: "Character views", zh: "Character views" }, description: { en: "Reference", zh: "Reference" } }],
  } }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function renderToolbar() {
  const result = render(
    <TooltipProvider>
      <NodeToolbar nodeId="image-1" nodeType="image-node" gridOpen={false} dismissSignal={0}
        onShowInspector={vi.fn()} onOpenFrameStrip={vi.fn()} onOpenClipStrip={vi.fn()}
        onOpenAudioClip={vi.fn()} onOpenLighting={vi.fn()} onGridOpenChange={vi.fn()} />
    </TooltipProvider>,
  );
  // The image toolbar has grid and creation popover triggers, in that order.
  return result.container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')[1];
}

describe("NodeToolbar creation menu", () => {
  it("keeps tooltip control mode stable across opening and selecting a preset", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const trigger = renderToolbar();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Character views Reference" }));
    await waitFor(() => expect(screen.queryByText("Views")).toBeNull());
    expect(dispatchNodeAction).toHaveBeenCalledWith("image-1", "create-template", { templateId: "characterThreeView" });
    expect(warn.mock.calls.flat().join(" ")).not.toContain("Tooltip is changing");
  });

  it("does not reopen the creation tooltip after a pointer selects a preset", async () => {
    const trigger = renderToolbar();
    // jsdom does not track input modality for :focus-visible as a browser does.
    const matches = trigger.matches.bind(trigger);
    vi.spyOn(trigger, "matches").mockImplementation((selector) => selector === ":focus-visible" ? false : matches(selector));
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("node.creation"));
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerUp(trigger);
    fireEvent.pointerLeave(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
    const preset = screen.getByRole("button", { name: "Character views Reference" });
    fireEvent.pointerDown(preset);
    fireEvent.click(preset);
    fireEvent.pointerUp(preset);
    await waitFor(() => expect(screen.queryByText("Views")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("restores keyboard focus and its tooltip after Escape closes the menu", async () => {
    const trigger = renderToolbar();
    act(() => trigger.focus());
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("node.creation"));
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("button", { name: "Character views Reference" }), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("node.creation"));
  });
});
