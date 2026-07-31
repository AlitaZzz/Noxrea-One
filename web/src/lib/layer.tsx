"use client";

import { Modal } from "antd";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";

// ─── Layer Context ───────────────────────────────────────────

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

// ─── Hooks ───────────────────────────────────────────────────

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

// ─── Internal hook for LayerModal ─────────────────────────────

interface LayerParent {
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

function useLayerParent(): LayerParent {
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

// ─── LayerModal ───────────────────────────────────────────────

type LayerModalProps = Omit<ComponentProps<typeof Modal>, "zIndex" | "getContainer">;

/**
 * Drop-in replacement for antd Modal that participates in the layer system.
 *
 * - Automatically mounts into the parent layer's overlay-root.
 * - Provides its own overlay-root so child modals/popups stay inside this layer.
 * - Computes a stable, bounded zIndex from `depth * 50 + 1000`.
 * - No need to pass `zIndex`, `getContainer`, or `rootClassName` for layering.
 */
export function LayerModal({ children, ...props }: LayerModalProps) {
  const { parentContainer, overlayRef, overlayRoot, depth, zIndex } =
    useLayerParent();

  return (
    <Modal
      getContainer={parentContainer}
      zIndex={zIndex}
      {...props}
    >
      <LayerContext.Provider value={{ overlayRoot, depth }}>
        {/* Content wrapper — creates a positioning context for the overlay-root */}
        <div style={{ position: "relative" }}>
          {children}

          {/* Overlay root — dedicated portal target for child modals,
              Select/Dropdown/Tooltip/Popover, and AssetCard menus.
              pointer-events:none allows clicks to pass through to content;
              child portals set their own pointer-events:auto. */}
          <div
            ref={overlayRef}
            data-layer-overlay-root
            data-layer-depth={depth}
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
            }}
          />
        </div>
      </LayerContext.Provider>
    </Modal>
  );
}

