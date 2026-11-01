// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

const { submit } = vi.hoisted(() => ({
  submit: {
    beginRun: vi.fn(),
    isCurrent: () => true,
    invalidate: vi.fn(),
    submitWithOwner: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
}));

vi.mock("@/lib/model-store", () => ({
  useModelStore: (selector: (state: unknown) => unknown) => selector({
    providers: [{
      id: "provider",
      name: "Provider",
      models: [{ id: "text-model", name: "text-model", capabilities: ["text"] }],
    }],
    findModelParams: () => null,
    modelParamsCache: {},
  }),
}));

vi.mock("@/features/canvas/shared/gen-settings", () => ({
  useGenSettings: () => ({ modelKey: "provider/text-model", prompt: "prompt" }),
  writeGenSettings: vi.fn(),
}));

vi.mock("@/features/canvas/shared/model-catalog", () => ({
  modelsForCapability: () => [{ value: "provider/text-model", name: "text-model", providerId: "provider" }],
}));

vi.mock("@/features/canvas/shared/last-model", () => ({
  resolveModelKey: () => "provider/text-model",
  recordLastModel: vi.fn(),
}));

vi.mock("@/features/canvas/shared/ref-order", () => ({
  EMPTY_ORDER: [],
  mergeOrder: (_pref: readonly string[], live: readonly string[]) => live,
  swapOrderItems: vi.fn(),
  writeOrderPref: vi.fn(),
}));

vi.mock("@/features/canvas/shared/prompt-presets", () => ({
  usePromptTemplateCatalog: () => ({ data: undefined }),
  expandPresetTokens: (text: string) => Promise.resolve(text),
  replacePresetToken: (text: string) => text,
}));

vi.mock("@/features/canvas/hooks/use-node-upstream-refs", () => ({
  useNodeUpstreamRefs: () => ({
    images: ["blob:image-1"],
    texts: [{ id: "text-1", content: "upstream" }],
    audios: [],
    videos: [],
  }),
}));

vi.mock("@/features/canvas/hooks/use-node-generating", () => ({
  useNodeGenerating: () => false,
}));

vi.mock("@/features/canvas/panels/use-generation-submit", () => ({
  useGenerationSubmit: () => submit,
  popPreGenSnapshot: vi.fn(),
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

vi.mock("@/features/canvas/shared/PresetMenuContent", () => ({ default: () => null }));
vi.mock("@/features/canvas/shared/AudioRefCard", () => ({ default: () => null }));
vi.mock("@/features/canvas/shared/VideoRefCard", () => ({ default: () => null }));
vi.mock("@/features/canvas/shared/ImageRefCard", () => ({
  default: () => <div data-testid="image-ref" />,
}));
vi.mock("@/features/canvas/shared/TextRefChip", () => ({
  default: () => <div data-testid="text-ref" />,
}));

vi.mock("@/components/ui/use-app-feedback", () => ({
  useAppFeedback: () => ({ notification: { error: vi.fn() } }),
}));

vi.mock("@/components/ui/IconActionButton", () => ({
  default: () => <button type="button">generate</button>,
}));

import TextGenerationPanel from "@/features/canvas/panels/TextGenerationPanel";

afterEach(cleanup);

describe("TextGenerationPanel reference chrome", () => {
  it("renders image references that arrive from upstream connections", () => {
    render(
      <TooltipProvider>
        <TextGenerationPanel nodeId="text-node" active />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("image-ref")).toBeTruthy();
    expect(screen.getByTestId("text-ref")).toBeTruthy();
  });
});
