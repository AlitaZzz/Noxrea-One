// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CanvasContextMenu from "@/features/canvas/controls/CanvasContextMenu";
import { useContextMenuStore } from "@/features/canvas/stores/context-menu-store";

vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({ screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }) }),
}));

vi.mock("@/components/ui/use-app-feedback", () => ({
  useAppFeedback: () => ({ message: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }),
}));

afterEach(() => {
  cleanup();
  act(() => useContextMenuStore.getState().hide());
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
});
