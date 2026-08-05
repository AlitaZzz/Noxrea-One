/**
 * 弹窗层级（Layer）基础设施的 Modal 组件。
 * 在 LayerModal 之上参与层级系统：自动挂载到父层级 overlay-root，
 * 并为本层提供 overlay-root 供子弹窗/下拉继续嵌套，zIndex 由 depth 推导。
 */
"use client";

import { Modal } from "antd";
import { type ComponentProps } from "react";

import { LayerContext, useLayerParent } from "./layer-context";

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
