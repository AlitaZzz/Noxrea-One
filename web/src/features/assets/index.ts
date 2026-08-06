/**
 * Assets feature 公开 API barrel。
 */

// ── 组件 ──
export { default as AssetsModal } from "./components/AssetsModal";
export { default as AssetGrid } from "./components/AssetGrid";
export { default as AssetCard } from "./components/AssetCard";
export { default as AssetToolbar } from "./components/AssetToolbar";
export { default as AssetNav } from "./components/AssetNav";
export { default as AssetCategoryTabs } from "./components/AssetCategoryTabs";
export { default as AssetCreateDialog } from "./components/AssetCreateDialog";
export { default as CreateFolderDialog } from "./components/CreateFolderDialog";
export { default as FolderCard } from "./components/FolderCard";
export {
  AssetHoverPreview,
  useAssetHoverPreview,
} from "./components/AssetHoverPreview";

// ── Store ──
export { useAssetsStore, ASSET_PAGE_SIZE } from "./store";

// ── API ──
export { assetApi } from "./api";
export type { AssetFolderDto, AssetItemDto } from "./api";

// ── 工具 ──
export { createAssetNode, type FindFreePosition } from "./add-asset";

// ── 类型 ──
export type {
  AssetType,
  AssetFolder,
  AssetItem,
  CreateAssetInput,
  MediaType,
} from "./types";
