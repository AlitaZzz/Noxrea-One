/**
 * 指针客户端坐标读取。
 *
 * 拖动参考点补偿（specs/canvas-drag-preview-session.md 规则 2.7）的两端都走这里：
 * 按下点（容器捕获阶段的 mousedown/touchstart）与阈值事件点（`onNodeDragStart`
 * 透传的 d3 `sourceEvent`）。鼠标与触屏的坐标字段不同，这里与 React Flow 自身的
 * `getEventPosition` 保持同一口径（鼠标取 clientX/clientY，触屏取 `touches[0]`）；
 * 两端必须同为 MouseEvent/TouchEvent，PointerEvent 的小数坐标与 MouseEvent 的
 * 整数坐标混用会留下亚像素误差。
 */
export function pointerClientPoint(event: unknown): { x: number; y: number } | null {
  if (!event || typeof event !== "object") return null;
  const mouse = event as MouseEvent;
  if (typeof mouse.clientX === "number" && typeof mouse.clientY === "number") {
    return { x: mouse.clientX, y: mouse.clientY };
  }
  const touch = (event as TouchEvent).touches?.[0];
  return touch ? { x: touch.clientX, y: touch.clientY } : null;
}
