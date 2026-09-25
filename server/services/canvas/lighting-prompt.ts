/**
 * 打光提示词插值。
 * 把光照面板传来的原始参数（intensity/azimuth/elevation + kelvin 或 color）映射为
 * 摄影语言描述词，再填入 prompt-template.json 中 lighting 模板的 {{占位符}}。
 * 前端不做语义翻译，方位、色温等英文描述全部在此完成，
 * 模板文案本身可热更新（改 JSON 即生效），描述词分段规则改动需发版。
 */

import { azimuthBase, clamp, num } from "./prompt-utils";

// 近乎垂直时方位角失去意义；斜射时保留水平与垂直两个方向。
function directionWord(azimuth: number, elevation: number): string {
  const base = azimuthBase(azimuth);
  if (elevation >= 60) return "directly above the scene";
  if (elevation > 15) return `above and to the ${base} of the scene`;
  if (elevation <= -60) return "directly below the scene";
  if (elevation < -15) return `below and to the ${base} of the scene`;
  return `to the ${base} of the scene`;
}

// 仰角(-90~90) → 光线照射角度描述（与 directionWord 的区间一致）。
function elevationWord(elevation: number): string {
  if (elevation >= 60) return "shining vertically downward";
  if (elevation > 15) return "shining diagonally downward";
  if (elevation >= -15) return "shining nearly horizontally";
  if (elevation > -60) return "shining diagonally upward";
  return "shining vertically upward";
}

// 色温(K) → 色光描述（覆盖面板 1500-10000 的调节范围）。
function kelvinWord(kelvin: number): string {
  if (kelvin <= 2200) return "candle-like warm orange light";
  if (kelvin <= 3500) return "warm yellow light";
  if (kelvin <= 4500) return "warm white light";
  if (kelvin <= 5500) return "neutral white light";
  if (kelvin <= 6500) return "daylight white light";
  if (kelvin <= 8000) return "cool white light";
  return "cool blue light";
}

// 强度(10-100) → 强弱描述。
function strengthWord(intensity: number): string {
  if (intensity <= 20) return "very low";
  if (intensity <= 40) return "soft";
  if (intensity <= 60) return "moderate";
  if (intensity <= 80) return "strong";
  return "very strong";
}

/** 把 lighting 模板的 {{占位符}} 按查询参数插值成成稿提示词 */
export function renderLightingTemplate(template: string, query: Record<string, string | undefined>): string {
  const intensity = clamp(Math.round(num(query.intensity, 50)), 10, 100);
  const azimuth = num(query.azimuth, 0);
  const elevation = clamp(Math.round(num(query.elevation, 0)), -90, 90);
  const kelvin = clamp(Math.round(num(query.kelvin, 0)), 1500, 10000);
  // 色温/自定义色二选一：面板按当前选项卡只传其一；都缺省时按自然白光兜底。
  // 描述词后括注原始值（K / hex），让生图模型拿到精确信息，也便于用户核对。
  const colorWord = query.kelvin !== undefined
    ? `${kelvinWord(kelvin)} (approximately ${kelvin}K)`
    : query.color
      ? `custom-colored light (${query.color})`
      : "neutral white light";

  const vars: Record<string, string> = {
    direction: directionWord(azimuth, elevation),
    elevation: elevationWord(elevation),
    color: colorWord,
    strength: `${strengthWord(intensity)} (approximately ${intensity}%)`,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}
