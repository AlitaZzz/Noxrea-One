// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import NodeToolbar from "@/features/canvas/nodes/NodeToolbar";
import { GROUP_COLOR_KEYS } from "@/lib/constants";

interface NodeFixture {
  id: string;
  data: Record<string, unknown>;
}

const { dispatchNodeAction, canvasState } = vi.hoisted(() => ({
  dispatchNodeAction: vi.fn(),
  canvasState: {
    nodes: [{ id: "image-1", data: { src: "/image.png" } }] as NodeFixture[],
  },
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("@/entities/asset", () => ({
  useKnownAssetKeys: () => new Set(),
  unsaveAssetsByFileKeys: vi.fn(),
}));
vi.mock("@/features/canvas/stores/canvas-store", () => ({
  useCanvasStore: (selector: (state: unknown) => unknown) => selector(canvasState),
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
  canvasState.nodes = [{ id: "image-1", data: { src: "/image.png" } }];
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

function renderNode(nodeType: string, data: Record<string, unknown>) {
  canvasState.nodes = [{ id: "node-1", data }];
  return render(
    <TooltipProvider>
      <NodeToolbar nodeId="node-1" nodeType={nodeType} gridOpen={false} dismissSignal={0}
        onShowInspector={vi.fn()} onOpenFrameStrip={vi.fn()} onOpenClipStrip={vi.fn()}
        onOpenAudioClip={vi.fn()} onOpenLighting={vi.fn()} onGridOpenChange={vi.fn()} />
    </TooltipProvider>,
  );
}

describe("NodeToolbar content gate", () => {
  it("does not render for media nodes without content", () => {
    for (const nodeType of ["image-node", "video-node", "audio-node"]) {
      const { container, unmount } = renderNode(nodeType, { src: "" });
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("does not render for a whitespace-only text node", () => {
    const { container } = renderNode("text-node", { plainText: " \n " });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the content actions for a text node with content", () => {
    const { container } = renderNode("text-node", { plainText: "hello" });
    // 信息 / 复制 / 下载
    expect(container.querySelectorAll("button")).toHaveLength(3);
  });

  it("keeps rendering for nodes without a content concept", () => {
    for (const nodeType of ["group-node", "director-node"]) {
      const { container, unmount } = renderNode(nodeType, {});
      expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
      unmount();
    }
  });
});

describe("NodeToolbar group layout menu", () => {
  it.each([
    ["node.smartLayout", "smart"],
    ["node.gridLayout", "grid"],
    ["node.horizontalLayout", "horizontal"],
    ["node.verticalLayout", "vertical"],
  ] as const)("dispatches %s and closes the menu", async (label, mode) => {
    const { container, unmount } = renderNode("group-node", {});
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    expect(trigger).not.toBeNull();

    fireEvent.keyDown(trigger!, { key: "ArrowDown" });
    await act(async () => {});
    fireEvent.click(screen.getByRole("menuitem", { name: label }));

    expect(dispatchNodeAction).toHaveBeenCalledWith("node-1", "layout", { mode });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    unmount();
  });
});

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
    // 指针模态由 lib/focus-ring.ts 的应用侧追踪判定，用真实事件驱动
    window.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
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
    // 显式回到键盘模态（模块级追踪在同一文件内跨用例保留）
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    const trigger = renderToolbar();
    act(() => trigger.focus());
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("node.creation"));
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("button", { name: "Character views Reference" }), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("node.creation"));
  });
});

describe("NodeToolbar group color picker", () => {
  it("previews the opaque group surface for default and colored swatches", async () => {
    const { container, unmount } = renderNode("group-node", { color: "blue" });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    expect(trigger).not.toBeNull();

    fireEvent.click(trigger!);
    await waitFor(() =>
      expect(document.querySelectorAll("button.rounded-full")).toHaveLength(GROUP_COLOR_KEYS.length)
    );

    const swatches = Array.from(document.querySelectorAll<HTMLButtonElement>("button.rounded-full"));
    expect(swatches[0].style.background).toBe("var(--canvas-group-bg)");
    const blue = swatches[GROUP_COLOR_KEYS.indexOf("blue")];
    expect(blue.style.background).toBe(
      "color-mix(in srgb, #1677ff 16%, var(--canvas-group-bg))"
    );
    unmount();
  });
});
