// @vitest-environment jsdom
/**
 * 图片节点接入分辨率 LOD 的接线契约（specs/canvas-media-resolution-lod.md 规则 2.2 / 9.3）：
 * 普通图片开启 LOD 并传入自然宽度上限；历史坏记录的 pendingNaturalSize 修复路径
 * 必须加载原图（用 img.naturalWidth 回写节点尺寸），因此关闭 LOD；上传预览不开启。
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flushMicrotasks, nodeViewProps } from "@/__tests__/test-utils/canvas-node";
import { makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";
import { TooltipProvider } from "@/components/ui/tooltip";
import ImageNode from "@/features/canvas/nodes/ImageNode";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { ImageNodeData } from "@/features/canvas/types";
vi.mock("@/lib/use-file-access-url", () => import("@/__tests__/test-utils/file-access-mock"));

/** 捕获 CanvasImage 实际收到的接线参数（lod / naturalWidth / src） */
const { canvasImages } = vi.hoisted(() => ({
  canvasImages: [] as Array<{ src: string; lod?: boolean; naturalWidth?: number }>,
}));

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("react-i18next", async (original) => ({
  ...await original<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
}));
vi.mock("@/components/ui/use-app-feedback", () => ({
  useAppFeedback: () => ({ notification: { error: vi.fn(), warning: vi.fn() } }),
}));
vi.mock("@/features/assets/store", () => ({ useAssetsStore: () => vi.fn() }));
vi.mock("@/features/canvas/upload", () => ({
  useNodeUpload: () => vi.fn(),
  runMediaUpload: vi.fn(),
  spawnPromptDerivedNode: vi.fn(),
}));
vi.mock("@/features/canvas/shared/prompt-presets", () => ({
  localizeText: (text: string) => text,
  presetTokenOf: (id: string) => id,
  usePromptPresets: () => ({ data: [] }),
}));
vi.mock("@/features/canvas/editing/AnnotationPanel", () => ({ default: () => null }));
vi.mock("@/features/canvas/editing/CropPanel", () => ({ default: () => null }));
vi.mock("@/features/canvas/editing/GridSplitter", () => ({ useGridSplit: () => vi.fn() }));
vi.mock("@/features/canvas/nodes/NodeTitle", () => ({ default: () => null }));
vi.mock("@/features/canvas/controls/ConnectionSideRail", () => ({ default: () => null }));
vi.mock("@/features/canvas/shared/MediaPreviewOverlay", () => ({ default: () => null }));
// 只记录接线参数：不进入真实调度器/视口（那部分由 CanvasImage 与 LOD hook 的测试覆盖）
vi.mock("@/features/canvas/shared/CanvasImage", () => ({
  default: (props: { src: string; lod?: boolean; naturalWidth?: number }) => {
    canvasImages.push({ src: props.src, lod: props.lod, naturalWidth: props.naturalWidth });
    return null;
  },
}));

const SOURCE_KEY = makeStorageKey("image-node", ".png");
const data: ImageNodeData = { label: "image", src: SOURCE_KEY, lockAspectRatio: true, naturalWidth: 1600, naturalHeight: 900 };

function NodeView() {
  const nodeData = useCanvasStore((state) => state.nodes[0].data) as ImageNodeData;
  return <TooltipProvider><ImageNode {...nodeViewProps<typeof ImageNode>("image", "image-node", nodeData)} /></TooltipProvider>;
}

beforeEach(() => {
  canvasImages.length = 0;
  useCanvasStore.setState({
    ...useCanvasStore.getInitialState(),
    nodes: [{ id: "image", type: "image-node", position: { x: 0, y: 0 }, data: { ...data } }],
  });
});
afterEach(() => {
  cleanup();
  useCanvasStore.setState(useCanvasStore.getInitialState(), true);
  vi.resetAllMocks();
});

describe("ImageNode 的 LOD 接入", () => {
  it("单图开启 LOD 并传入已知自然宽度", async () => {
    render(<NodeView />);
    await flushMicrotasks();
    expect(canvasImages).toEqual([{ src: SOURCE_KEY, lod: true, naturalWidth: 1600 }]);
  });

  it("pendingNaturalSize 修复路径关闭 LOD（必须用原图回写真实尺寸）", async () => {
    useCanvasStore.setState({
      nodes: [{
        id: "image",
        type: "image-node",
        position: { x: 0, y: 0 },
        data: { ...data, pendingNaturalSize: { width: 512, height: 288 } },
      }],
    });
    render(<NodeView />);
    await flushMicrotasks();
    expect(canvasImages).toHaveLength(1);
    expect(canvasImages[0].lod).toBe(false);
  });

  it("多图堆叠：主图传自然宽度，非主图不传上限；展开网格同样开启 LOD", async () => {
    const otherKey = makeStorageKey("image-node-other", ".png");
    useCanvasStore.setState({
      nodes: [{
        id: "image",
        type: "image-node",
        position: { x: 0, y: 0 },
        data: { ...data, multiResultKeys: [SOURCE_KEY, otherKey] },
      }],
    });
    render(<NodeView />);
    await flushMicrotasks();
    const main = canvasImages.find((item) => item.src === SOURCE_KEY)!;
    const stacked = canvasImages.find((item) => item.src === otherKey)!;
    expect(main).toEqual({ src: SOURCE_KEY, lod: true, naturalWidth: 1600 });
    expect(stacked.lod).toBe(true);
    expect(stacked.naturalWidth).toBeUndefined();
  });

  it("上传预览（blob:）不开启 LOD", async () => {
    useCanvasStore.setState({
      nodes: [{
        id: "image",
        type: "image-node",
        position: { x: 0, y: 0 },
        data: { ...data, upload: { uploading: true, previewUrl: "blob:preview", version: 1 } as ImageNodeData["upload"] },
      }],
    });
    render(<NodeView />);
    await flushMicrotasks();
    const preview = canvasImages.find((item) => item.src === "blob:preview");
    expect(preview).toBeDefined();
    expect(preview!.lod).toBeUndefined();
  });
});
