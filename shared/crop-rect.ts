/**
 * 视频画面裁剪矩形的共享契约与钳位实现（单一数据源）。
 * 客户端管线（web）与服务端兜底路由（server）共用同一 clampRect——
 * 客户端失败回退服务端时，两端必须对同一矩形产出一致的偶数钳位结果，
 * 语义漂移在实现层即不存在，而非靠两侧测试各自断言来兜底。
 */

/** 源像素坐标系的裁剪矩形（视频画面裁剪 API 的请求契约） */
export interface CropRectPx {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把裁剪矩形钳进源画面，且偏移 / 宽高全部取偶（yuv420p 色度采样要求）。
 * 钳位顺序：宽高先取偶并钳进源尺寸 → 偏移按剩余可用空间取偶钳位 →
 * 宽高下限兜底 2 → 偏移下限兜底 0，保证结果恒有 x + width ≤ srcW。
 */
export function clampRect(
  rect: CropRectPx,
  srcW: number,
  srcH: number,
): CropRectPx {
  const even = (v: number) => v - (v % 2);
  let width = Math.min(even(rect.width), even(srcW));
  let height = Math.min(even(rect.height), even(srcH));
  let x = Math.min(even(rect.x), even(srcW - width));
  let y = Math.min(even(rect.y), even(srcH - height));
  width = Math.max(2, width);
  height = Math.max(2, height);
  x = Math.max(0, x);
  y = Math.max(0, y);
  return { x, y, width, height };
}
