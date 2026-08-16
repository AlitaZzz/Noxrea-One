/**
 * 语义字段 → 上游字段 的解析器。
 * 按 {field, kind, transform?} 规格，把前端固定语义槽位组装成上游真实结构，
 * 并按 transform 规则换算值。
 *
 * kind 结构枚举：
 *   - "single"        单值：取 refImages[0]
 *   - "array"         字符串数组：整个 refImages[]
 *   - "array[].k"     对象数组展开：refImages[] → [{ k: url }]
 *   - "role:first-last" 首尾帧成对：slots.firstFrame/lastFrame → [{url, role:first_frame}, {url, role:last_frame}]
 *   - "role:xxx"      带角色对象：slots.firstFrame/lastFrame/refImages → [{ url, role }]
 *   - "slot:first"    首帧单值：slots.firstFrame
 *   - "slot:last"     尾帧单值：slots.lastFrame
 *
 * transform 值换算（声明式）：
 *   - "lookup"        多字段组合查表（composite + table）
 *   - "map"           单字段查表（table）
 *   - "ratio"         像素尺寸反推比例（如 1024x1024 → 1:1）
 */

import type { FieldMapSpec, TransformSpec } from "@server/services/model-config";

/** 参考模式（对齐原 refmode.ts） */
export type RefMode = "none" | "first" | "first-last" | "full";

/** 有序参考图派生出的语义槽位 */
export interface RefSlots {
  firstFrame: string | null;
  lastFrame: string | null;
  refImages: string[];
}

/**
 * 按参考模式 + 有序参考图数组派生首帧/尾帧/全参考。
 * 前端只传有序 refImages[]，这里按 refMode 从数组位置取图。
 *
 * capability 用于区分参考语义：
 *   - "image"：参考图全部作为参考（全参考），不存在 refMode / 首尾帧概念。
 *   - "video"（默认）：按 refMode 派生首帧/尾帧/全参考。
 */
export function resolveRefSlots(
  refMode: RefMode | string | undefined,
  refImages: string[],
  capability?: string
): RefSlots {
  const imgs = Array.isArray(refImages) ? refImages : [];

  // 图像能力：参考图无首尾帧语义，直接全量参考
  if (capability === "image") {
    return { firstFrame: null, lastFrame: null, refImages: imgs };
  }

  switch (refMode) {
    case "first":
      return { firstFrame: imgs[0] ?? null, lastFrame: null, refImages: imgs };
    case "first-last":
      return { firstFrame: imgs[0] ?? null, lastFrame: imgs[1] ?? null, refImages: imgs };
    case "full":
      return { firstFrame: null, lastFrame: null, refImages: imgs };
    default: // none / undefined
      return { firstFrame: null, lastFrame: null, refImages: [] };
  }
}

/**
 * 按 kind 组装上游字段值（不包含 transform 换算）。
 * 返回 [上游字段名, 值]；值为 undefined 时表示该字段无内容，应跳过。
 */
export function resolveByKind(spec: FieldMapSpec, slots: RefSlots): [string, unknown] {
  const kind = spec.kind;

  // role:first-last —— 首尾帧成对对象数组（先于通用 role:xxx 匹配）
  if (kind === "role:first-last") {
    const items: Array<{ url: string; role: string }> = [];
    if (slots.firstFrame) items.push({ url: slots.firstFrame, role: "first_frame" });
    if (slots.lastFrame) items.push({ url: slots.lastFrame, role: "last_frame" });
    return [spec.field, items.length ? items : undefined];
  }

  // role:xxx —— 带角色的对象数组
  const roleMatch = kind.match(/^role:(.+)$/);
  if (roleMatch) {
    const role = roleMatch[1];
    const items: Array<{ url: string; role: string }> = [];
    if (role === "first_frame" && slots.firstFrame) items.push({ url: slots.firstFrame, role });
    else if (role === "last_frame" && slots.lastFrame) items.push({ url: slots.lastFrame, role });
    else {
      for (const img of slots.refImages) items.push({ url: img, role });
    }
    return [spec.field, items.length ? items : undefined];
  }

  // slot:first / slot:last —— 首尾帧单值
  if (kind === "slot:first") return [spec.field, slots.firstFrame ?? undefined];
  if (kind === "slot:last") return [spec.field, slots.lastFrame ?? undefined];

  // array[].k —— 对象数组展开
  const arrExpandMatch = kind.match(/^array\[\]\.(.+)$/);
  if (arrExpandMatch) {
    const nestedKey = arrExpandMatch[1];
    const items = slots.refImages.map((url) => ({ [nestedKey]: url }));
    return [spec.field, items.length ? items : undefined];
  }

  // array —— 字符串数组
  if (kind === "array") {
    return [spec.field, slots.refImages.length ? slots.refImages : undefined];
  }

  // single —— 单值
  if (kind === "single") {
    return [spec.field, slots.refImages[0] ?? undefined];
  }

  // 未知 kind：按 single 兜底
  return [spec.field, slots.refImages[0] ?? undefined];
}

/**
 * 按 transform 规则换算值。
 * 返回换算后的值。
 */
export function applyTransform(
  transform: TransformSpec | undefined,
  value: unknown,
  ctx: Record<string, unknown>
): unknown {
  if (!transform) return value;

  switch (transform.type) {
    case "lookup": {
      const table = transform.table ?? {};
      const composite = transform.composite ?? [];
      const key = composite.map((f) => String(ctx[f] ?? "")).join("|");
      const found = table[key];
      if (found === undefined) return value;
      return Array.isArray(found) ? found[0] : found;
    }
    case "map": {
      const table = transform.table ?? {};
      const strVal = String(value);
      const found = table[strVal];
      if (found === undefined) return value;
      return Array.isArray(found) ? found[0] : found;
    }
    case "ratio": {
      return ratioFromSize(String(value));
    }
    default:
      return value;
  }
}

/** 像素尺寸反推比例（如 "1024x1024" → "1:1"） */
function ratioFromSize(value: string): string {
  const m = value.trim().toLowerCase().match(/^(\d+)[x*](\d+)$/);
  if (!m) return value;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w <= 0 || h <= 0) return value;

  const candidates: Array<[number, number, string]> = [
    [1, 1, "1:1"],
    [2, 1, "2:1"],
    [1, 2, "1:2"],
    [3, 1, "3:1"],
    [1, 3, "1:3"],
    [5, 4, "5:4"],
    [4, 5, "4:5"],
    [16, 9, "16:9"],
    [9, 16, "9:16"],
    [4, 3, "4:3"],
    [3, 4, "3:4"],
    [3, 2, "3:2"],
    [2, 3, "2:3"],
    [21, 9, "21:9"],
    [9, 21, "9:21"],
  ];
  for (const [cw, ch, ratio] of candidates) {
    const diff = Math.abs(w * ch - h * cw);
    if (diff * 100 <= w * ch * 4) return ratio;
  }
  return value;
}

/** 写入嵌套路径（a.b.c） */
export function setNested(d: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = d;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
