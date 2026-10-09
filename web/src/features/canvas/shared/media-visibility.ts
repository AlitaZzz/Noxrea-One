export type MediaLoadPriority = 0 | 1 | null;
export const MEDIA_PREFETCH_MARGIN = 240;

type Rect = { x: number; y: number; width: number; height: number };
type Viewport = { width: number; height: number; transform: readonly [number, number, number] };

export function mediaLoadPriority(rect: Rect, viewport: Viewport): MediaLoadPriority {
  const [tx, ty, zoom] = viewport.transform;
  if (viewport.width <= 0 || viewport.height <= 0 || rect.width <= 0 || rect.height <= 0 || zoom <= 0) return null;
  const x = rect.x * zoom + tx;
  const y = rect.y * zoom + ty;
  const width = rect.width * zoom;
  const height = rect.height * zoom;
  const intersects = (margin: number) => x < viewport.width + margin && x + width > -margin && y < viewport.height + margin && y + height > -margin;
  if (intersects(0)) return 0;
  return intersects(MEDIA_PREFETCH_MARGIN) ? 1 : null;
}
