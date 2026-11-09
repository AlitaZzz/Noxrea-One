/**
 * 资产领域公共 API。
 *
 * 只暴露类型、读取 Hook/selector、写命令与原始上传；
 * store、API DTO 与内部实现不对外。
 */

// ── 类型 ──
export type { AddAssetsBatchResult } from "./store";
export type { AssetFolder, AssetItem, AssetScope, AssetType, CreateAssetInput } from "./types";
export type { RawUploadItem, RawUploadSummary } from "./upload";

// ── 常量 ──
export { ASSET_DRAG_TYPE, ASSET_NAME_MAX_LENGTH } from "./constants";

// ── 读取 ──
export {
  getAssetsInitialized,
  useAssetFolders,
  useAssetLibraryVersion,
  useAssetsInitialized,
  useKnownAssetKeys,
} from "./selectors";

// ── 写命令 ──
export {
  addAsset,
  addAssetsBatch,
  addFolder,
  initialize,
  removeAssetsBatch,
  removeFolder,
  renameFolder,
  unsaveAssetsByFileKeys,
  updateAsset,
  updateAssetsBatch,
} from "./commands";

// ── 原始上传 ──
export { uploadMany, uploadOne } from "./upload";

// ── 查询 Hook ──
export { useAssetLibrary } from "./use-asset-library";
