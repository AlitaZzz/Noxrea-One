/**
 * 数值工具（shared）。
 *
 * 与业务无关的通用数值约束放在这里，领域模块只引用、不重复实现。
 */

/** 钳制到 [0, 1]；非有限值按 0 处理（NaN / Infinity 不参与比例计算）。 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
