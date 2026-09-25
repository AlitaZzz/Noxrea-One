/**
 * 多角度（相机机位）提示词插值。
 * 把多角度面板传来的原始参数（azimuth/elevation/zoom）映射为机位摄影语言，
 * 再填入 prompt-template.json 中 angle 模板的 {{占位符}}。
 * 与打光同一链路：前端不做语义翻译，全部在此完成；模板文案热更新，
 * 描述词分段规则改动需发版。仰角约定与打光相同（>0 为上方），
 * 此处以相机视角措辞：上方即俯拍、下方即仰拍。
 */

import { azimuthBase, clamp, num } from "./prompt-utils";

// 机位方位：方位角 → 机位相对主体的位置描述。
function viewpointWord(azimuth: number): string {
  const base = azimuthBase(azimuth);
  if (base === "front") return "directly in front of the subject";
  if (base === "rear") return "directly behind the subject";
  return `to the ${base} of the subject`;
}

// 俯仰角(-90~90，>0 俯拍)：±60 仍属于斜拍，避免与原始角度矛盾。
function pitchWord(elevation: number): string {
  if (elevation > 60) return "looking straight down from above";
  if (elevation > 15) return "looking down from above";
  if (elevation >= -15) return "at eye level";
  if (elevation >= -60) return "looking up from below";
  return "looking straight up from below";
}

// 景别(0/1/2) → 景别描述。
function distanceWord(zoom: number): string {
  if (zoom <= 0) return "close-up, with the subject's details filling the frame";
  if (zoom >= 2) return "wide shot, showing the complete subject in its environment";
  return "medium shot, balancing the subject and its surroundings";
}

/** 把 angle 模板的 {{占位符}} 按查询参数插值成成稿提示词 */
export function renderAngleTemplate(template: string, query: Record<string, string | undefined>): string {
  const azimuth = ((num(query.azimuth, 0) % 360) + 360) % 360;
  const elevation = clamp(Math.round(num(query.elevation, 0)), -90, 90);
  const zoom = clamp(Math.round(num(query.zoom, 1)), 0, 2);

  const vars: Record<string, string> = {
    // 括注原始值与打光模板同一风格，便于生图模型和用户核对。
    // 近垂直时方位角不再决定机位方向；±60 仍保留方位。
    viewpoint: elevation > 60
      ? "directly above the subject"
      : elevation < -60
        ? "directly below the subject"
        : `${viewpointWord(azimuth)} (azimuth approximately ${azimuth}°)`,
    pitch: `${pitchWord(elevation)} (elevation approximately ${elevation}°)`,
    distance: distanceWord(zoom),
    // 正背面机位需合理补全原图不可见的部分；近垂直视角不触发。
    note: azimuthBase(azimuth) === "rear" && elevation >= -60 && elevation <= 60
      ? "Reconstruct the parts of the subject's back that are not visible in the reference image based on its structure; match the original detail level and art style. "
      : "",
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}
