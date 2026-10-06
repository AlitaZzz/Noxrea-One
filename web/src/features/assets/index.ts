/**
 * Assets feature 公开 API barrel。
 */

// ── 组件 ──
export { default as AssetCard } from "./components/AssetCard";
export { default as AssetCreateDialog } from "./components/AssetCreateDialog";
export { default as AssetGrid } from "./components/AssetGrid";
export { AssetHoverPreview } from "./components/AssetHoverPreview";
export { default as AssetsDialog } from "./components/AssetsDialog";
export { default as AssetToolbar } from "./components/AssetToolbar";
export { default as CreateFolderDialog } from "./components/CreateFolderDialog";
export { default as FolderCard } from "./components/FolderCard";

// ── Store ──
export { ASSET_PAGE_SIZE,useAssetsStore } from "./store";

// ── API ──
export type { AssetFolderDto, AssetItemDto } from "./api";
export { assetApi } from "./api";

// ── 工具 ──
export { createAssetNode, type FindFreePosition } from "./add-asset";

// ── 类型 ──
export type {
  AssetFolder,
  AssetItem,
  AssetType,
  CreateAssetInput,
  MediaType,
} from "./types";
