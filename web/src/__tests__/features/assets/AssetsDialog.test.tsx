/**
 * AssetsDialog 公共 props 契约：开合、单选插入与批量插入。
 *
 * 容器自身的查询/上传/文件夹链路由各自 hook 与子组件测试覆盖；这里只
 * 验证「插入画布」的对外行为——回调参数、成功提示与批量集合。
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
    reload: vi.fn(),
    loadMore: vi.fn(),
    retry: vi.fn(),
    removeItems: vi.fn(async () => {}),
    patchItems: vi.fn(),
    appliedSearch: "",
  }),
  addAssetsBatch: vi.fn(),
  addFolder: vi.fn(),
  removeAssetsBatch: vi.fn(),
  removeFolder: vi.fn(),
  renameFolder: vi.fn(),
  updateAsset: vi.fn(),
  updateAssetsBatch: vi.fn(),
}));

vi.mock("@/components/ui/use-app-feedback", () => ({
  useAppFeedback: () => ({
    message: { success: mocks.success, error: vi.fn(), info: vi.fn(), warning: vi.fn() },
    notification: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  }),
}));

vi.mock("@/features/assets/components/AssetGrid", () => ({
  default: ({
    assets,
    onToggleSelect,
    onInsertCanvas,
  }: {
    assets: AssetItem[];
    onToggleSelect: (asset: AssetItem) => void;
    onInsertCanvas: (asset: AssetItem) => void;
  }) => (
    <div data-testid="asset-grid">
      {assets.map((asset) => (
        <div key={asset.id}>
          <button type="button" onClick={() => onToggleSelect(asset)}>
            {`toggle-${asset.id}`}
          </button>
          <button type="button" onClick={() => onInsertCanvas(asset)}>
            {`insert-${asset.id}`}
          </button>
        </div>
      ))}
    </div>
  ),
}));

vi.mock("@/features/assets/components/AssetInspector", () => ({
  default: ({ assets, onInsert }: { assets: AssetItem[]; onInsert: (asset: AssetItem) => void }) =>
    assets.length === 1 ? (
      <button type="button" onClick={() => onInsert(assets[0])}>
        inspector-insert
      </button>
    ) : null,
}));

vi.mock("@/features/assets/components/AssetToolbar", () => ({ default: () => null }));
vi.mock("@/features/assets/components/AssetBreadcrumb", () => ({ default: () => null }));
vi.mock("@/features/assets/components/AssetCreateDialog", () => ({ default: () => null }));
vi.mock("@/features/assets/components/CreateFolderDialog", () => ({ default: () => null }));

import AssetsDialog from "@/features/assets/components/AssetsDialog";

function asset(id: string, name = id): AssetItem {
  return {
    id,
    name,
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

function renderDialog(overrides: Partial<ComponentProps<typeof AssetsDialog>> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    onInsertAsset: vi.fn(),
    onInsertAssets: vi.fn(),
    ...overrides,
  };
  const view = render(
    <TooltipProvider>
      <AssetsDialog {...props} />
    </TooltipProvider>,
  );
  return { ...props, view };
}

beforeEach(() => {
  mocks.success.mockReset();
  mocks.items = [asset("a"), asset("b")];
});

describe("AssetsDialog 插入契约", () => {
  it("关闭时不渲染内容", () => {
    renderDialog({ open: false });
    expect(screen.queryByText("asset.title")).toBeNull();
  });

  it("打开后渲染资产库标题与网格", () => {
    renderDialog();
    expect(screen.getByText("asset.title")).toBeInTheDocument();
    expect(screen.getByTestId("asset-grid")).toBeInTheDocument();
  });

  it("网格单卡插入：回调收到该资产并提示成功", () => {
    const { onInsertAsset } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "insert-a" }));

    expect(onInsertAsset).toHaveBeenCalledTimes(1);
    expect(onInsertAsset).toHaveBeenCalledWith(mocks.items[0]);
    expect(mocks.success).toHaveBeenCalledWith("asset.added");
  });

  it("检查器单项插入：同样经 onInsertAsset", () => {
    const { onInsertAsset } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "toggle-a" }));
    fireEvent.click(screen.getByRole("button", { name: "inspector-insert" }));

    expect(onInsertAsset).toHaveBeenCalledWith(mocks.items[0]);
  });

  it("批量插入：多选后一次回调收到全部选中资产", () => {
    const { onInsertAssets } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "toggle-a" }));
    fireEvent.click(screen.getByRole("button", { name: "toggle-b" }));
    fireEvent.click(screen.getByRole("button", { name: /asset\.addToCanvas/ }));

    expect(onInsertAssets).toHaveBeenCalledTimes(1);
    expect(onInsertAssets).toHaveBeenCalledWith([mocks.items[0], mocks.items[1]]);
    expect(mocks.success).toHaveBeenCalledWith("asset.addedCount");
  });

  it("仅选一项时不出现批量条，也不会误触发批量插入", () => {
    const { onInsertAssets } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "toggle-a" }));

    expect(screen.queryAllByRole("button", { name: /asset\.addToCanvas/ })).toHaveLength(0);
    expect(onInsertAssets).not.toHaveBeenCalled();
  });
});
