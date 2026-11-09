/**
 * 资产领域公共常量。
 */

/**
 * 资产卡片拖入画布时 dataTransfer 上的自定义标记（值为 AssetItem 的 JSON）。
 * 拖拽源（资产卡片）与落点（画布文件拖放）共用此常量。
 */
export const ASSET_DRAG_TYPE = "application/x-asset";

/**
 * 素材名称长度上限：定义在 `shared/asset` 供前后端共用，经 entity 公共 API 转发，
 * 调用方不从 shared 深导入（模块契约见 `specs/web-module-contracts.md`）。
 */
export { ASSET_NAME_MAX_LENGTH } from "@noxrea/shared/asset";
