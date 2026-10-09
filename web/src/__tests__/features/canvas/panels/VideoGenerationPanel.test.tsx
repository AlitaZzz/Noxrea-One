// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

const { writeGenSettings, modelState } = vi.hoisted(() => ({
  writeGenSettings: vi.fn(),
  modelState: { hasModels: true, paramsAvailable: true },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/i18n/config", () => ({
  default: { exists: () => false, t: (key: string) => key },
}));

vi.mock("@/lib/model-store", () => ({
  useModelStore: (selector: (state: unknown) => unknown) => selector({
    providers: modelState.hasModels ? [{
      id: "provider",
      name: "Provider",
      models: [{ id: "video-model", name: "video-model", capabilities: ["video"] }],
    }] : [],
    findModelParams: () => modelState.paramsAvailable ? ({
      fields: [],
      capabilities: { refMode: { options: ["text", "full"] } },
    }) : null,
    modelParamsCache: {},
  }),
}));

vi.mock("@/features/canvas/shared/ref-order", () => ({
  useGenSettings: () => ({ modelKey: "provider/video-model", prompt: "prompt", refMode: "text" }),
  writeGenSettings,
  writeOrderPref: vi.fn(),
  swapOrderItems: vi.fn(),
}));

vi.mock("@/features/canvas/shared/last-model", () => ({
  resolveModelKey: (_value: unknown, _capability: unknown, models: { value: string }[]) => models[0]?.value ?? "",
  recordLastModel: vi.fn(),
}));

vi.mock("@/features/canvas/panels/use-video-gen-panel", () => ({
  useVideoGenPanel: () => ({
    refOrder: [],
    audioOrder: [],
    refVideoOrder: [],
    upstreamTexts: [],
    upstreamAudio: [],
    references: [],
    finalPrompt: "prompt",
    isGenerating: false,
  }),
}));

vi.mock("@/features/canvas/panels/use-generation-submit", () => ({
  useGenerationSubmit: () => ({
    beginRun: vi.fn(),
    isCurrent: () => true,
    invalidate: vi.fn(),
    submitWithOwner: vi.fn(),
    dropPendingHistory: vi.fn(),
  }),
}));

vi.mock("@/features/canvas/api/generation-api", () => ({
  generationApi: { submitGenerationTask: vi.fn(), cancelGenerationTask: vi.fn() },
}));

vi.mock("@/features/canvas/stores/canvas-store", () => ({
  markDirtyImmediate: vi.fn(),
  useCanvasStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ nodes: [] }),
    { getState: () => ({ nodes: [], updateNodeData: vi.fn() }) },
  ),
}));

vi.mock("@/features/canvas/upload", () => ({
  useRefUpload: () => vi.fn(),
}));

vi.mock("@/features/model/components/ModelSelector", () => ({
  ModelSelector: () => <button type="button">model</button>,
}));

vi.mock("@/features/canvas/shared/MentionPrompt", () => ({
  default: () => <textarea aria-label="prompt" />,
}));

vi.mock("@/features/canvas/shared/AudioRefCard", () => ({ default: () => null }));
vi.mock("@/features/canvas/shared/ImageRefCard", () => ({ default: () => null }));
vi.mock("@/features/canvas/shared/VideoRefCard", () => ({ default: () => null }));
vi.mock("@/features/canvas/shared/TextRefChip", () => ({ default: () => null }));

vi.mock("@/components/ui/use-app-feedback", () => ({
  useAppFeedback: () => ({ notification: { error: vi.fn() } }),
}));

vi.mock("@/components/ui/IconActionButton", () => ({
  default: () => <button type="button">generate</button>,
}));

vi.mock("@/components/ui/ParamFields", () => ({
  default: () => null,
  ParamSummary: () => null,
}));

vi.mock("@/features/canvas/shared/ratio-size", () => ({ applyRatioToNode: vi.fn() }));

import VideoGenerationPanel from "@/features/canvas/panels/VideoGenerationPanel";

afterEach(() => {
  cleanup();
  writeGenSettings.mockClear();
  modelState.hasModels = true;
  modelState.paramsAvailable = true;
});

describe("VideoGenerationPanel parameter availability", () => {
  it.each([
    { hasModels: false, paramsAvailable: true, message: "modelConfig.selectModelForParams" },
    { hasModels: true, paramsAvailable: false, message: "modelConfig.paramsUnavailable" },
    { hasModels: true, paramsAvailable: true, message: "modelConfig.emptyParams" },
  ])("shows $message for the actual model and configuration state", ({ hasModels, paramsAvailable, message }) => {
    Object.assign(modelState, { hasModels, paramsAvailable });
    const { container } = render(
      <TooltipProvider>
        <VideoGenerationPanel nodeId="video-node" />
      </TooltipProvider>,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
    fireEvent.click(trigger);
    expect(screen.getByRole("status")).toHaveTextContent(message);
    expect(writeGenSettings).not.toHaveBeenCalled();
  });
});

describe("VideoGenerationPanel reference mode menu", () => {
  it("keeps an unavailable mode open and unchanged on Enter", () => {
    render(
      <TooltipProvider>
        <VideoGenerationPanel nodeId="video-node" />
      </TooltipProvider>,
    );

    const trigger = screen.getByRole("button", { name: /video\.refMode\.text/ });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const unavailable = screen.getByRole("menuitem", { name: "video.refMode.full" });
    expect(unavailable).toHaveAttribute("aria-disabled", "true");

    fireEvent.keyDown(unavailable, { key: "Enter" });

    expect(writeGenSettings).not.toHaveBeenCalledWith("video-node", { refMode: "full" });
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("keeps an unavailable mode open and unchanged on pointer selection", () => {
    render(
      <TooltipProvider>
        <VideoGenerationPanel nodeId="video-node" />
      </TooltipProvider>,
    );

    const trigger = screen.getByRole("button", { name: /video\.refMode\.text/ });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const unavailable = screen.getByRole("menuitem", { name: "video.refMode.full" });

    fireEvent.click(unavailable);

    expect(writeGenSettings).not.toHaveBeenCalledWith("video-node", { refMode: "full" });
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});
