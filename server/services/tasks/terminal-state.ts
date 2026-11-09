/**
 * 任务终态事件契约。
 * 类型放在独立叶子模块：终态用例（terminal.ts）依赖事件总线，事件总线与
 * watcher、SSE 路由只需状态形状，不应反向依赖终态编排模块。
 */
import type { TerminalTaskStatus } from "@noxrea/shared";

export interface TerminalTaskState {
  taskId: string;
  status: TerminalTaskStatus;
  resultUrls?: string[];
  resultText?: string;
  error?: string;
  /** 机器可读的失败分类，前端据此取本地化文案 */
  errorCode?: string;
  prompt?: string;
  config?: unknown;
}
