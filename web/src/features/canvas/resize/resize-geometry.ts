/**
 * 缩放手势的纯几何。
 *
 * 右下角手柄：尺寸 = 起始尺寸 + 指针位移 / 按下时 zoom，先 `Math.round` 再按
 * 最小尺寸收敛。预览帧与提交共用本函数，保证松手落点与拖动中的最后一帧一致。
 */
import type { Point } from "@/features/canvas/shared/geometry";

export interface ResizeStart {
  /** 按下点（client 坐标，屏幕像素） */
  pointer: Point;
  /** 起始宽高（画布单位） */
  width: number;
  height: number;
  /** 按下时锁定的视口缩放 */
  zoom: number;
}

export interface ResizeSize {
  width: number;
  height: number;
}

export function computeResizeSize(
  start: ResizeStart,
  pointer: Point,
  min: ResizeSize,
): ResizeSize {
  // zoom 在按下时锁定；异常值按 1 处理，避免除零把尺寸打成 Infinity
  const zoom = Number.isFinite(start.zoom) && start.zoom > 0 ? start.zoom : 1;
  const dx = (pointer.x - start.pointer.x) / zoom;
  const dy = (pointer.y - start.pointer.y) / zoom;
  return {
    width: Math.max(min.width, Math.round(start.width + dx)),
    height: Math.max(min.height, Math.round(start.height + dy)),
  };
}
