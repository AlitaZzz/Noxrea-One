// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import CropPanel from "@/features/canvas/editing/CropPanel";

vi.mock("@xyflow/react", () => ({
  NodeToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Position: { Bottom: "bottom" },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "zh" } }),
}));
vi.mock("@/features/canvas/stores/canvas-store", () => ({
  useCanvasStore: Object.assign((selector: (s: unknown) => unknown) => selector({ setModalOpen: vi.fn() }), {
    getState: () => ({}),
  }),
}));
vi.mock("@/features/canvas/upload", () => ({
  runMediaUpload: vi.fn(),
}));
vi.mock("@/lib/utils/image-utils", () => ({
  canvasToBlob: vi.fn(),
  loadMediaDimensions: vi.fn(() => Promise.resolve({ width: 100, height: 100 })),
}));

afterEach(cleanup);

function renderPanel() {
  return render(
    <TooltipProvider>
      <CropPanel src="/api/files/x.png" sourceId="s1" onClose={vi.fn()} />
    </TooltipProvider>,
  );
}

describe("图片裁剪面板遮罩契约", () => {
  it("不再渲染全幅压暗遮罩（双层压暗回归守卫）", () => {
    const { container } = renderPanel();

    expect(container.querySelector('[class*="bg-black/50"]')).toBeNull();
  });

  it("裁剪框自带 9999px 投影与固定白描边，不再用主题色描边", () => {
    const { container } = renderPanel();

    const cutout = container.querySelector('[class*="9999px"]') as HTMLElement;
    expect(cutout).toBeTruthy();
    expect(cutout.style.borderColor).toBe("rgb(255, 255, 255)");
  });

  it("三分网格线容器带投影，明亮画面下可辨", () => {
    const { container } = renderPanel();

    expect(container.querySelector('[class*="drop-shadow-"]')).toBeTruthy();
  });
});
