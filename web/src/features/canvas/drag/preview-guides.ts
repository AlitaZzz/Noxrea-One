/**
 * 拖动预览辅助线的瞬态订阅。
 *
 * 辅助线不属于画布数据：不进 store、不进历史、不落库。拖动会话每帧只在这里
 * 发布，`AlignmentGuides` 通过 `useSyncExternalStore` 订阅——画布外壳与节点树
 * 不随辅助线变化重渲染（specs/canvas-drag-preview-session.md 规则 3.3）。
 */
import {
  type AlignmentGuide,
  sameAlignmentGuides,
} from "@/features/canvas/hooks/use-alignment-guides";

let guides: AlignmentGuide[] = [];
const listeners = new Set<() => void>();

export function getPreviewGuides(): AlignmentGuide[] {
  return guides;
}

export function subscribePreviewGuides(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 发布当前帧辅助线；内容未变时不通知（同序逐项相等，拖动位置帧大多无变化） */
export function setPreviewGuides(next: AlignmentGuide[]): void {
  if (sameAlignmentGuides(guides, next)) return;
  guides = next;
  for (const listener of listeners) listener();
}

export function clearPreviewGuides(): void {
  setPreviewGuides([]);
}
