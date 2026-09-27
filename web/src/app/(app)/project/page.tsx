/**
 * 项目列表页路由壳（/project）。
 * UI 与数据逻辑在 features/project/components/ProjectListPage——与画布页
 * 「page 薄壳 + feature 厚组件」模式对齐。
 */
import ProjectListPage from "@/features/project/components/ProjectListPage";

export default function ProjectPage() {
  return <ProjectListPage />;
}
