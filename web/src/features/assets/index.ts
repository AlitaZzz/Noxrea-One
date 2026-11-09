/**
 * 资产界面功能公开 API。
 *
 * 数据、查询与写命令统一由 `@/entities/asset` 提供；本模块只组合资产相关界面。
 * 只导出页面实际挂载的两个入口，其余组件是 feature 内部组合件。
 */

// ── 组件 ──
export { default as AssetBrowserPanel } from "./components/AssetBrowserPanel";
export { default as AssetsDialog } from "./components/AssetsDialog";
