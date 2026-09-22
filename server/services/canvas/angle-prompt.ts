/**
 * 多角度（相机机位）提示词插值。
 * 把多角度面板传来的原始参数（azimuth/elevation/zoom）映射为机位摄影语言，
 * 再填入 prompt-template.json 中 angle 模板的 {{占位符}}。
 * 与打光同一链路：前端不做语义翻译，全部在此完成；模板文案热更新，
 * 描述词分段规则改动需发版。仰角约定与打光相同（>0 为上方），
 * 此处以相机视角措辞：上方即俯拍、下方即仰拍。
 */

import { azimuthBase, clamp, num } from "./prompt-utils";

// 机位方位：方位角 → 机位相对主体的位置描述
function viewpointWord(azimuth: number): string {
  const base = azimuthBase(azimuth);
  if (base === "前") return "主体正前方";
  if (base === "后") return "主体正后方";
  return `主体${base}方`;
}

// 俯仰角(-90~90，>0 俯拍) → 拍摄角度描述。边界取开区间：±60 已是明显斜射，
// 不再归入「垂直顶视/仰视」，避免措辞与括注的原始角度自相矛盾
function pitchWord(elevation: number): string {
  if (elevation > 60) return "自正上方垂直向下的顶视";
  if (elevation > 15) return "自上而下俯拍";
  if (elevation >= -15) return "与人眼等高的平视";
  if (elevation >= -60) return "自下而上仰拍";
  return "自正下方垂直向上的仰视";
}

// 景别(0/1/2) → 景别描述
function distanceWord(zoom: number): string {
  if (zoom <= 0) return "近景特写，主体细节占满画面";
  if (zoom >= 2) return "远景全景，主体完整呈现在环境中";
  return "中景，主体与环境均衡呈现";
}

/** 把 angle 模板的 {{占位符}} 按查询参数插值成成稿提示词 */
export function renderAngleTemplate(template: string, query: Record<string, string | undefined>): string {
  const azimuth = ((num(query.azimuth, 0) % 360) + 360) % 360;
  const elevation = clamp(Math.round(num(query.elevation, 0)), -90, 90);
  const zoom = clamp(Math.round(num(query.zoom, 1)), 0, 2);

  const vars: Record<string, string> = {
    // 括注原始值与打光模板同一风格，便于生图模型和用户核对。
    // 近垂直仰角下方位角失去意义（同打光 directionWord 的收敛思路，边界取开区间与 pitchWord 一致）：
    // >60 只说正上方，<-60 只说正下方
    viewpoint: elevation > 60
      ? "主体正上方"
      : elevation < -60
        ? "主体正下方"
        : `${viewpointWord(azimuth)}（方位角约 ${azimuth}°）`,
    pitch: `${pitchWord(elevation)}（俯仰角约 ${elevation}°）`,
    distance: distanceWord(zoom),
    // 背面机位原图未观察到的部分需要模型合理补全，其余机位留空。
    // 窗口与八方位的「后」扇区对齐，右后/左后扇区背面大半可见，不触发；
    // 近垂直俯仰（视角已收敛为正上/正下方）背面不在画面内，同样不触发
    note: azimuthBase(azimuth) === "后" && elevation >= -60 && elevation <= 60
      ? "原图中未直接展示的背面部分需依据主体结构合理补全，细节密度与画风须与原图一致。"
      : "",
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}
