/**
 * Auth feature 公开 API barrel。
 * 用户状态与命令归 `entities/user`；本模块只提供用户菜单与账户设置 UI。
 */

// ── 组件 ──
export { default as SettingsModal } from "./components/SettingsModal";
export { UserMenuPopover } from "./components/UserMenuPopover";
