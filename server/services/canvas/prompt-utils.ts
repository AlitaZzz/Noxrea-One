/**
 * 提示词插值共享工具（lighting / angle 两个渲染服务共用）。
 * 方位角约定：0-359，0=正面，顺时针增；八方位映射是打光与多角度面板
 * 对同一滑杆取值的唯一语义来源，改动须同时核对面板预览方向。
 */

export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
export const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// 方位角 → 八方位词基座（去「方」字，供与上/下/前/后组合）
const AZIMUTH_BASES = ["前", "右前", "右", "右后", "后", "左后", "左", "左前"];
export function azimuthBase(azimuth: number): string {
  return AZIMUTH_BASES[Math.round(((((azimuth % 360) + 360) % 360) / 45)) % 8];
}
