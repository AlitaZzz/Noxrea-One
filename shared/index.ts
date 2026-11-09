/**
 * 前后端共享契约（单一数据源）。
 *
 * internal package 模式：直接发布 TS 源码（exports 指向 .ts），server 由 tsx/
 * esbuild 原生加载，web 由 Next transpilePackages 处理，无独立构建产物。
 * 两侧类型一律从这里派生（z.infer），不再各自维护字面量联合——契约漂移在
 * 类型检查阶段即报错，而不是等运行时才发现。
 */
import { z } from "zod";

export const frameSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("last") }).strict(),
  z.object({ kind: z.literal("time"), seconds: z.number().finite().min(0) }).strict(),
]);
export type FrameSelection = z.infer<typeof frameSelectionSchema>;

// ── 生成任务状态 ──
// zod schema 为唯一来源，状态全集与类型均由它派生

/** 任务状态校验模式 */
export const taskStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

/** 任务状态全集 */
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** 任务状态全集（运行时常量） */
export const TASK_STATUSES = taskStatusSchema.options;

/** 终态子集：终态判断、事件广播与对账接口的共同契约 */
export const TASK_TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

/** 终态类型：由终态子集派生；crud 与 services 共用，避免任一侧自行维护字面量 */
export type TerminalTaskStatus = (typeof TASK_TERMINAL_STATUSES)[number];

/** 终态判断的单一谓词：server 路由 / worker 与 web SSE 共用同一实现 */
export function isTerminalTaskStatus(status: string): status is TerminalTaskStatus {
  return (TASK_TERMINAL_STATUSES as readonly string[]).includes(status);
}
