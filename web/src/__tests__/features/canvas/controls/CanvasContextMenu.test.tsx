// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CanvasContextMenu from "@/features/canvas/controls/CanvasContextMenu";
import {
  CANVAS_CLIPBOARD_KIND,
  CANVAS_CLIPBOARD_VERSION,
} from "@/features/canvas/shared/canvas-clipboard-format";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useContextMenuStore } from "@/features/canvas/stores/context-menu-store";
import { useSelectionStore } from "@/features/canvas/stores/selection-store";
import i18n from "@/lib/i18n/config";

const mocks = vi.hoisted(() => ({ readSystemClipboard: vi.fn() }));
vi.mock("@/features/canvas/shared/canvas-system-clipboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/canvas/shared/canvas-system-clipboard")>();
  return { ...actual, readSystemClipboard: mocks.readSystemClipboard };
});

vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({ screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }) }),
}));

vi.mock("@/components/ui/use-app-feedback", () => ({
  useAppFeedback: () => ({ message: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }),
}));

afterEach(() => {
  cleanup();
  act(() => useContextMenuStore.getState().hide());
  mocks.readSystemClipboard.mockReset();
  useSelectionStore.setState({ clipboard: null });
});

describe("CanvasContextMenu", () => {
  it.each(["create", "canvas", "node"] as const)("renders the %s menu when its store state opens", async (kind) => {
    render(
      <CanvasContextMenu
        onAddText={vi.fn()}
        onAddImage={vi.fn()}
        onAddVideo={vi.fn()}
        onAddAudio={vi.fn()}
        onAddDirector={vi.fn()}
        onTidy={vi.fn()}
        tidyDisabled={false}
        onResetView={vi.fn()}
      />,
    );

    act(() => useContextMenuStore.getState().show(120, 240, kind, "node-1"));

    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
  });

  it("pastes the newest system clipboard content instead of the stale internal snapshot", async () => {
    useCanvasStore.setState({
      ...useCanvasStore.getInitialState(),
      nodes: [],
      edges: [],
    });
    useSelectionStore.getState().copySelected(
      [{ id: "old", type: "text-node", position: { x: 0, y: 0 }, data: { label: "Old", content: "", plainText: "" } }],
      [],
    );
    mocks.readSystemClipboard.mockResolvedValue({
      payloadJson: JSON.stringify({
        kind: CANVAS_CLIPBOARD_KIND,
        version: CANVAS_CLIPBOARD_VERSION,
        nodes: [
          {
            id: "new",
            type: "text-node",
            position: { x: 0, y: 0 },
            data: { label: "New", content: "<p>New</p>", plainText: "New" },
          },
        ],
        edges: [],
      }),
      imageFiles: [],
      text: "",
    });

    render(
      <CanvasContextMenu
        onAddText={vi.fn()}
        onAddImage={vi.fn()}
        onAddVideo={vi.fn()}
        onAddAudio={vi.fn()}
        onAddDirector={vi.fn()}
        onTidy={vi.fn()}
        tidyDisabled={false}
        onResetView={vi.fn()}
      />,
    );

    act(() => useContextMenuStore.getState().show(120, 240, "canvas"));

    const pasteItem = await screen.findByRole("menuitem", {
      name: new RegExp(i18n.t("common.paste")),
    });
    fireEvent.click(pasteItem);

    await waitFor(() => expect(useCanvasStore.getState().nodes).toHaveLength(1));
    expect(mocks.readSystemClipboard).toHaveBeenCalledTimes(1);
    expect(useCanvasStore.getState().nodes[0].data.label).toBe("New");
  });
});
