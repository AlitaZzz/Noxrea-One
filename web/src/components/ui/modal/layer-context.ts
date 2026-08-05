/**
 * 弹窗层级（Layer）基础设施的 Context 层。
 * 通过 Context 记录当前所处的浮层深度与 overlay 根节点，
 * 使嵌套弹窗、下拉菜单能挂载到正确的层级容器，避免 z-index 与滚动穿透问题。
 */
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";

interface LayerState {
  /** The overlay-root DOM node of the current layer.
   *  Child modals/popups should render into this node. */
  overlayRoot: HTMLElement | null;
  /** Depth of the current layer. 0 = body-level (no modal). */
  depth: number;
}

const LayerContext = createContext<LayerState>({
  overlayRoot: null,
  depth: 0,
});

export { LayerContext };

/**
 * Hook for components that need to portal into the *current* layer's
 * overlay-root (e.g. AssetCard menu, custom dropdowns).
 * Returns null at depth 0 (body-level) — callers should fall back to
 * the nearest overlay-root via DOM lookup or document.body.
 */
export function useLayerOverlay(): HTMLElement | null {
  return useContext(LayerContext).overlayRoot;
}

/**
 * Returns the nearest layer overlay-root by walking up the DOM from `trigger`.
 * Falls back to `document.body`.  Designed to be passed as antd
 * `getPopupContainer` at the ConfigProvider level.
 */
export function getLayerPopupContainer(
  trigger?: HTMLElement,
): HTMLElement | ShadowRoot {
  if (!trigger) return document.body;
  const el = trigger.closest<HTMLElement>("[data-layer-overlay-root]");
  return el || document.body;
}

/** Props for the internal LayerModal hook. */
export interface LayerParent {
  /** Where to mount THIS modal (parent's overlay-root, or body). */
  parentContainer: HTMLElement | undefined;
  /** Callback ref — attach to the overlay-root div created by this modal. */
  overlayRef: (node: HTMLDivElement | null) => void;
  /** The overlay-root DOM node (null until mounted). */
  overlayRoot: HTMLDivElement | null;
  /** Computed depth & zIndex for this layer. */
  depth: number;
  zIndex: number;
}

/** 供 LayerModal 内部使用的父层级解析 hook。 */
export function useLayerParent(): LayerParent {
  const parent = useContext(LayerContext);
  const [overlayRoot, setOverlayRoot] = useState<HTMLDivElement | null>(null);

  const overlayRef = useCallback((node: HTMLDivElement | null) => {
    setOverlayRoot(node);
  }, []);

  const depth = parent.depth + 1;
  const zIndex = 1000 + (depth - 1) * 50;
  const parentContainer = parent.overlayRoot || undefined;

  return { parentContainer, overlayRef, overlayRoot, depth, zIndex };
}

export type { ComponentProps, ReactNode };
