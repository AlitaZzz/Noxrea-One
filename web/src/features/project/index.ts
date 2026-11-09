/**
 * `features/project` 公共入口：项目列表页 UI。
 * 项目摘要与命令归 `entities/project`；本 feature 不导入 canvas，
 * 画布保存 flush 由 app 层注入。
 */
export { default as ProjectListPage } from "./components/ProjectListPage";
