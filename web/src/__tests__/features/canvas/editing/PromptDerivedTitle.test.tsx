// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { getPromptTemplate } from "@/features/canvas/api/canvas-api";
import LightingPanel from "@/features/canvas/editing/LightingPanel";
import MultiAngleEditor from "@/features/canvas/editing/MultiAngleEditor";
import { createImageNode } from "@/features/canvas/node-defaults";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => `translated:${key}` }),
}));
vi.mock("@/components/ui/use-app-feedback", () => ({
  useAppFeedback: () => ({ notification: { error: vi.fn() } }),
}));
vi.mock("@/features/canvas/editing/OrbitScene3D", () => ({ default: () => null }));
vi.mock("@/features/canvas/api/canvas-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/features/canvas/api/canvas-api")>(),
  getPromptTemplate: vi.fn(),
}));
vi.mock("@/features/project/save-manager", () => ({
  saveManager: { markDirty: vi.fn(), markDirtyImmediate: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  useCanvasStore.setState({ nodes: [], edges: [] });
  useHistoryStore.getState().clear();
  vi.mocked(getPromptTemplate).mockResolvedValue("derived prompt");
});

afterEach(() => {
  cleanup();
  useCanvasStore.setState({ nodes: [], edges: [] });
  useHistoryStore.getState().clear();
});

describe("prompt-derived node titles", () => {
  it.each([
    { Panel: LightingPanel, templateType: "lighting", titleKey: "lighting.title" },
    { Panel: MultiAngleEditor, templateType: "angle", titleKey: "angle.editor" },
  ])("$templateType creates a node with a localized action title", async ({ Panel, templateType, titleKey }) => {
    const source = createImageNode({ x: 0, y: 0 }, "/api/files/source.png");
    source.data.label = "Source image";
    useCanvasStore.setState({ nodes: [source], edges: [] });
    const onClose = vi.fn();

    render(
      <TooltipProvider>
        <Panel src={source.data.src!} nodeId={source.id} onClose={onClose} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(useCanvasStore.getState().nodes).toHaveLength(2));
    const store = useCanvasStore.getState();
    const derived = store.nodes.find((node) => node.id !== source.id)!;
    expect(derived).toMatchObject({
      type: "image-node",
      data: { label: `translated:${titleKey}`, genSettings: { prompt: "derived prompt" } },
    });
    expect(store.edges).toEqual([expect.objectContaining({ source: source.id, target: derived.id })]);
    expect(store.nodes.find((node) => node.id === source.id)?.data.label).toBe("Source image");
    expect(getPromptTemplate).toHaveBeenCalledWith(templateType, expect.any(Object));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
