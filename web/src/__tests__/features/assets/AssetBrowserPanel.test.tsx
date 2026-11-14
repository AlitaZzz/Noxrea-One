/**
 * AssetBrowserPanel 公共 props 契约：紧凑网格选项与点击插入回调。
 *
 * 拖拽插入走 `ASSET_DRAG_TYPE`，由网格与画布共同负责；本面板只把
 * `draggable` 传给网格，并让点击插入经 `onInsertAsset` 交还调用方。
 */
// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { AssetItem } from "@/entities/asset";

vi.mock("react-i18next", () => import("@/__tests__/test-utils/react-i18next-mock"));

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  items: [] as AssetItem[],
  gridProps: null as Record<string, unknown> | null,
}));

vi.mock("@/entities/asset", () => ({
  useAssetFolders: () => [],
  useAssetLibrary: () => ({
    items: mocks.items,
    totalCount: mocks.items.length,
    loading: false,
    loadingMore: false,
    loadError: null,
    hasMore: false,
    loadMore: vi.fn(),
    retry: vi.fn(),
    appliedSearch: "",
  }),
}));

vi.mock("@/components/ui/use-app-feedback", () => ({
  useAppFeedback: () => ({
    message: { success: mocks.success, error: vi.fn(), info: vi.fn(), warning: vi.fn() },
    notification: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  }),
}));

vi.mock("@/features/assets/components/AssetBreadcrumb", () => ({ default: () => null }));

vi.mock("@/features/assets/components/AssetGrid", () => ({
  default: (props: {
    assets: AssetItem[];
    onInsertCanvas: (asset: AssetItem) => void;
    [key: string]: unknown;
  }) => {
    mocks.gridProps = props;
    return (
      <div data-testid="panel-grid">
        {props.assets.map((asset) => (
          <button key={asset.id} type="button" onClick={() => props.onInsertCanvas(asset)}>
            {`panel-insert-${asset.id}`}
          </button>
        ))}
      </div>
    );
  },
}));

import AssetBrowserPanel from "@/features/assets/components/AssetBrowserPanel";

function asset(id: string): AssetItem {
  return {
    id,
    name: id,
    type: "scene",
    mediaType: "image",
    width: 100,
    height: 100,
    size: 0,
    duration: 0,
    description: "",
    createdAt: 0,
    updatedAt: 0,
    tags: [],
    prompt: "",
    scope: "personal",
  };
}

function renderPanel(overrides: Partial<ComponentProps<typeof AssetBrowserPanel>> = {}) {
  const props = { onInsertAsset: vi.fn(), ...overrides };
  render(
    <TooltipProvider>
      <AssetBrowserPanel {...props} />
    </TooltipProvider>,
  );
  return props;
}

beforeEach(() => {
  mocks.success.mockReset();
  mocks.items = [asset("a")];
  mocks.gridProps = null;
});

describe("AssetBrowserPanel 契约", () => {
  it("以紧凑、可拖拽、带插入按钮的网格展示资产", () => {
    renderPanel();

    expect(screen.getByTestId("panel-grid")).toBeInTheDocument();
    expect(mocks.gridProps).toMatchObject({
      compact: true,
      showHoverPreview: true,
      showInsertButton: true,
      draggable: true,
    });
    // 无搜索/分类时根目录参与网格
    expect(Array.isArray(mocks.gridProps?.folders)).toBe(true);
  });

  it("点击插入：onInsertAsset 收到资产并提示成功", () => {
    const { onInsertAsset } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "panel-insert-a" }));

    expect(onInsertAsset).toHaveBeenCalledTimes(1);
    expect(onInsertAsset).toHaveBeenCalledWith(mocks.items[0]);
    expect(mocks.success).toHaveBeenCalledWith("asset.added");
  });
});
