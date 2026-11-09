/**
 * 时间戳解析（前后端共用）。
 * 非法或缺失时返回 fallback；默认 NaN 保留「无效时间」语义，由调用方决定回落值。
 */
export function toTimestamp(value: string | null | undefined, fallback = Number.NaN): number {
  if (value == null) return fallback;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : fallback;
}
