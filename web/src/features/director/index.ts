/**
 * Director feature 公开 API barrel。
 * 只导出页面级挂载点；内部面板与 store 归本 feature 私有，
 * 跨 feature 的导演数据类型走 `entities/director`。
 */

// ── 组件 ──
export { default as DirectorOverlay } from "./components/DirectorOverlay";
