/**
 * 画布基础纯类型（背景 / 主题 / 视口 / 任务绑定 / 上传状态）。
 *
 * 为何放在 lib 层：`lib/constants.ts` 中大量运行时常量（DEFAULT_VIEWPORT、
 * EMPTY_TASK_BINDING、isGenerating 等）依赖这些类型，而架构分层约定 lib 只能
 * 依赖 lib。若类型留在 features/canvas/types，就会形成 lib → features 的反向依赖。
 *
 * features/canvas/types.ts 会从这里转出，上层既有的
 * `import type { … } from "@/features/canvas/types"` 导入路径保持不变。
 */
import type { UploadErrorInfo } from "@/lib/utils/upload";

export type BackgroundType = "dots" | "grid" | "blank";
export type ThemeMode = "light" | "dark";

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface TaskBinding {
  /** 后端任务 ID（本地处理如裁剪/变换时为空串） */
  taskId: string;
  status: TaskStatus;
  /** 异步任务的语义动作 */
  pendingAction?: string;
  /** 任务开始时间戳（ms），用于生成中遮罩显示实时耗时 */
  startedAt?: number;
}

export interface UploadState {
  uploading: boolean;
  /** 上传进度 0-100 */
  progress?: number;
  /** 防竞态版本号：每次重新上传自增，回调按版本号丢弃过期结果 */
  version: number;
  /** 上传期间的本地预览 URL（blob:或 data:），用于模糊背景渲染 */
  previewUrl?: string;
  /**
   * 失败态信息：存在且 uploading 为 false 时，节点渲染失败遮罩与重试 / 移除入口。
   * 失败节点会留在画布上（不自动删除），避免裁剪 / 标注等加工产物白做。
   */
  error?: UploadErrorInfo;
}
