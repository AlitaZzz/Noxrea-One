/**
 * 弹窗层级（Layer）基础设施的 Modal 组件。
 * 在 LayerModal 之上参与层级系统：自动挂载到父层级 overlay-root，
 * 并为本层提供 overlay-root 供子弹窗/下拉继续嵌套，zIndex 由 depth 推导。
 */
"use client";

import { Modal } from "antd";
import { type ComponentProps, useCallback, useEffect, useRef, useState } from "react";

import { LayerContext, useLayerParent } from "./layer-context";

type LayerModalProps = Omit<ComponentProps<typeof Modal>, "getContainer" | "zIndex"> & {
  /** 显式指定 zIndex（默认由 depth 推导）。用于 Drawer 等不参与 layer 系统的容器内，
   *  需要压过容器自身 z-index 的场景（如 Drawer 默认 1000，确认框传 1050）。 */
  zIndex?: number;
  /** 挂到 document.body 而非父 layer 的 overlay-root：用于需要全屏遮罩、
   打断底层上下文的弹窗（如破坏性二次确认）。zIndex 默认提升到 1050。 */
  global?: boolean;
};

/**
 * Drop-in replacement for antd Modal that participates in the layer system.
 *
 * - Automatically mounts into the parent layer's overlay-root.
 * - Provides its own overlay-root so child modals/popups stay inside this layer.
 * - Computes a stable, bounded zIndex from `depth * 50 + 1000`.
 * - No need to pass `zIndex`, `getContainer`, or `rootClassName` for layering.
 */
export function LayerModal({
  children,
  zIndex: explicitZIndex,
  global: isGlobal = false,
  centered = false,
  open,
  style,
  ...props
}: LayerModalProps) {
  const { parentContainer, overlayRef, overlayRoot, depth, zIndex } =
    useLayerParent();

  // antd 的 centered 用 vertical-align:middle 垂直居中，弹窗 top 几乎总是小数坐标；
  // 盒子与字形各自吸附设备像素网格，结果按钮文字偏上 1px。
  // 这里弃用 antd 居中，自己算 top = round((视口高 - 弹窗高) / 2)，落点恒为整数。
  // 弹窗 DOM 由 Portal 延后挂载（effect 时机拿不到），故经 panelRef 回调驱动：
  // 挂载即测一次，之后 ResizeObserver 跟随内容/视口变化重测。
  const panelElRef = useRef<HTMLElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [snapTop, setSnapTop] = useState<number | null>(null);

  const snap = useCallback(() => {
    const el = panelElRef.current;
    const box = el?.classList.contains("ant-modal") ? el : el?.closest<HTMLElement>(".ant-modal");
    const wrap = box?.parentElement;
    if (!box || !wrap) return;
    const top = Math.max(0, Math.round((wrap.clientHeight - box.offsetHeight) / 2));
    setSnapTop((prev) => (prev === top ? prev : top));
  }, []);

  const attachPanel = useCallback(
    (el: HTMLElement | null) => {
      panelElRef.current = el;
      roRef.current?.disconnect();
      roRef.current = null;
      if (!el || !open) return;
      snap();
      const ro = new ResizeObserver(snap);
      ro.observe(el);
      if (el.parentElement) ro.observe(el.parentElement);
      roRef.current = ro;
    },
    [open, snap],
  );

  useEffect(() => {
    if (!centered || !open) return;
    attachPanel(panelElRef.current);
    window.addEventListener("resize", snap);
    return () => {
      roRef.current?.disconnect();
      roRef.current = null;
      window.removeEventListener("resize", snap);
    };
  }, [centered, open, attachPanel, snap]);

  return (
    <Modal
      getContainer={isGlobal ? () => document.body : parentContainer}
      zIndex={isGlobal ? (explicitZIndex ?? 1050) : (explicitZIndex ?? zIndex)}
      open={open}
      panelRef={centered ? attachPanel : undefined}
      style={centered && snapTop !== null ? { ...style, top: snapTop } : style}
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
