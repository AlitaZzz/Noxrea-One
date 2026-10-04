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
  /** Base z-index for the current layer. 0 = body-level (use component defaults). */
  zIndex: number;
}

const LayerContext = createContext<LayerState>({
  overlayRoot: null,
  depth: 0,
  zIndex: 0,
});

export { LayerContext };

/** Props for the internal Dialog layer hook. */
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

/** 供 Dialog 内部使用的父层级解析 hook。 */
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

/** Resolve the z-index for a popup rendered by Radix's body-level Portal. */
export function useLayerZIndex() {
  const { zIndex } = useContext(LayerContext);
  return zIndex > 0 ? zIndex + 1 : undefined;
}

export type { ComponentProps, ReactNode };
