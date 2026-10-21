/**
 * system_settings 时长换算：注册表以秒 / 分 / 小时存储，需要毫秒时走这里，
 * 避免各处重复魔法数，也避免同一业务规则在不同模块出现口径漂移。
 */
const SECONDS_PER_MINUTE = 60;
/** 秒单位常量供注册表表达定时器上限与默认周期（如 GC 每日一次），单位定义单点。 */
export const SECONDS_PER_DAY = 24 * 60 * 60;
/** 毫秒单位常量同时供注册表推导 Number 安全域边界，保证单位定义单点。 */
export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;

/** 给定单位的毫秒值，返回换算成毫秒后仍落在 Number 安全整数域内的最大整数值。 */
export function maxSafeUnits(unitMs: number): number {
  return Math.floor(Number.MAX_SAFE_INTEGER / unitMs);
}

/** 分 → 秒（cookie maxAge 等以秒为单位的接口）。 */
export function minutesToSeconds(minutes: number): number {
  return minutes * SECONDS_PER_MINUTE;
}

/** 秒 → 毫秒。注册表已保证换算结果落在 Number 安全整数域。 */
export function secondsToMs(seconds: number): number {
  return seconds * MS_PER_SECOND;
}

/** 分 → 毫秒。注册表已保证换算结果落在 Number 安全整数域。 */
export function minutesToMs(minutes: number): number {
  return minutes * MS_PER_MINUTE;
}

/** 小时 → 毫秒。注册表已保证换算结果落在 Number 安全整数域。 */
export function hoursToMs(hours: number): number {
  return hours * MS_PER_HOUR;
}
