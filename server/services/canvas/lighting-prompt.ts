/**
 * 打光提示词插值。
 * 把光照面板传来的原始参数（intensity/azimuth/elevation + kelvin 或 color）映射为
 * 摄影语言描述词，再填入 prompt-template.json 中 lighting 模板的 {{占位符}}。
 * 前端不做语义翻译，方位→「左上方」、色温→「暖黄色光」等全部在此完成，
 * 模板文案本身可热更新（改 JSON 即生效），描述词分段规则改动需发版。
 */

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// 方位角(0-359，0=前方，顺时针增) → 八方位词基座（去「方」字，供与上/下组合）
const AZIMUTH_BASES = ["前", "右前", "右", "右后", "后", "左后", "左", "左前"];
function azimuthBase(azimuth: number): string {
  return AZIMUTH_BASES[Math.round(((((azimuth % 360) + 360) % 360) / 45)) % 8];
}

// 方向主词：方位角与仰角融合成单一方向词，避免出现「正上方却斜射」的矛盾——
// 平射区间用纯方位词；斜射区间用「左上方」式组合词；接近垂直时方位角失去意义才收敛为正上/正下
function directionWord(azimuth: number, elevation: number): string {
  const base = azimuthBase(azimuth);
  if (elevation >= 60) return "正上方";
  if (elevation > 15) return `${base}上方`;
  if (elevation <= -60) return "正下方";
  if (elevation < -15) return `${base}下方`;
  return `${base}方`;
}

// 仰角(-90~90) → 光线照射角度描述（与 directionWord 的区间一致，互相印证不矛盾）
function elevationWord(elevation: number): string {
  if (elevation >= 60) return "自画面正上方垂直向下照射";
  if (elevation > 15) return "自上方斜向下照射画面";
  if (elevation >= -15) return "沿接近画面水平的方向照射";
  if (elevation > -60) return "自下方斜向上照射画面";
  return "自画面正下方垂直向上照射";
}

// 色温(K) → 色光描述（经验分段，覆盖面板 1500-10000 的调节范围）
function kelvinWord(kelvin: number): string {
  if (kelvin <= 2200) return "烛光般的暖橙色光";
  if (kelvin <= 3500) return "暖黄色光";
  if (kelvin <= 4500) return "暖白光";
  if (kelvin <= 5500) return "自然白光";
  if (kelvin <= 6500) return "正午白光";
  if (kelvin <= 8000) return "冷白色光";
  return "冷蓝色光";
}

// 强度(10-100) → 强弱描述
function strengthWord(intensity: number): string {
  if (intensity <= 20) return "微弱";
  if (intensity <= 40) return "柔和";
  if (intensity <= 60) return "适中";
  if (intensity <= 80) return "较强";
  return "强烈";
}

/** 把 lighting 模板的 {{占位符}} 按查询参数插值成成稿提示词 */
export function renderLightingTemplate(template: string, query: Record<string, string | undefined>): string {
  const intensity = clamp(Math.round(num(query.intensity, 50)), 10, 100);
  const azimuth = num(query.azimuth, 0);
  const elevation = clamp(Math.round(num(query.elevation, 0)), -90, 90);
  const kelvin = clamp(Math.round(num(query.kelvin, 0)), 1500, 10000);
  // 色温/自定义色二选一：面板按当前选项卡只传其一；都缺省时按自然白光兜底。
  // 描述词后括注原始值（K / hex），让生图模型拿到精确信息，也便于用户核对
  const colorWord = query.kelvin !== undefined
    ? `${kelvinWord(kelvin)}（色温约 ${kelvin}K）`
    : query.color
      ? `自定义色光（${query.color}）`
      : "自然白光";

  const vars: Record<string, string> = {
    direction: directionWord(azimuth, elevation),
    elevation: elevationWord(elevation),
    color: colorWord,
    // 描述词后括注原始百分比，与色光的括注风格一致，便于模型和用户核对
    strength: `${strengthWord(intensity)}（约 ${intensity}%）`,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}
