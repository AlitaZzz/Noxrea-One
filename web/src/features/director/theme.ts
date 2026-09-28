/**
 * Director 3D 场景的语义色板。
 * three.js 侧消费 0xRRGGBB 数值，UI 侧（cssText / Inspector 色值）消费 HEX 字符串——
 * 字符串形态一律由数值派生，保证场景与面板同一来源、改值不漏。
 */

/** 实体默认主色：选中环 / 无色实体兜底 / 实体色板首色 */
export const DIRECTOR_PRIMARY = 0x4f8ef7;

/** 角色素体默认色（截图同款素体绿），Inspector 兜底同源 */
export const DIRECTOR_CHARACTER_COLOR = 0x34c759;
export const DIRECTOR_CHARACTER_HEX = `#${DIRECTOR_CHARACTER_COLOR.toString(16).padStart(6, "0")}`;

/** 相机实体机身橙，实体标签底色同源 */
export const DIRECTOR_CAMERA_COLOR = 0xff8a3d;
export const DIRECTOR_CAMERA_HEX = `#${DIRECTOR_CAMERA_COLOR.toString(16).padStart(6, "0")}`;

/** 场景底色：背景与雾同源（store 默认 sky 亦引用派生的 HEX 形态） */
export const DIRECTOR_SCENE_BG = 0x060608;
export const DIRECTOR_SCENE_BG_HEX = `#${DIRECTOR_SCENE_BG.toString(16).padStart(6, "0")}`;
