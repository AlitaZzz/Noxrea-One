/**
 * 项目领域公共 API。
 *
 * 只暴露摘要类型、读取 Hook/selector、写命令与全局写互斥；
 * store、元数据 API 与内部实现不对外。画布文档类型与保存编排归 `features/canvas`。
 */

// ── 类型 ──
export type { ProjectSummary } from "./types";

// ── 摘要投影 ──
export { type ProjectSummarySource, toProjectSummary } from "./summary";

// ── 读取 ──
export {
  getProjectRevision,
  useActiveProjectId,
  useActiveProjectSummary,
  useProjects,
} from "./selectors";

// ── 写命令 ──
export {
  activateProject,
  createProject,
  deleteProject,
  refreshProjects,
  renameProject,
  updateCover,
  updateProjectRevision,
  upsertProjectSummary,
} from "./commands";

// ── 写互斥 ──
export { runProjectWrite } from "./save-mutex";
