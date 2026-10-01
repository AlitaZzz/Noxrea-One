/**
 * 全站统一弹窗基座。
 *
 * 职责合并自原 AppModal + LayerModal：两者此前是「壳样式 + antd Modal 包装」的上下层关系，
 * 且 LayerModal 全仓仅此一个消费者，分层没有带来任何复用价值，只多一层间接。
 * 现在对外签名不变，内部直接基于 antd Modal 并实现层级系统。
 *
 * 层级（Layer）行为：
 *   - 默认挂载到父层级的 overlay-root，并为本层提供 overlay-root 供子弹窗 / 下拉继续嵌套；
 *   - zIndex 由 depth 推导；`global` 挂到 document.body 且 zIndex 提升到 1050，
 *     用于需要全屏遮罩、打断底层上下文的弹窗（如破坏性二次确认）。
 */
"use client";

import { Modal } from "antd";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { LayerContext, useLayerParent } from "@/components/ui/modal/layer-context";

interface AppModalProps {
  title: ReactNode;
  open: boolean;
  onCancel: () => void;
  width?: number | string;
  footer?: ReactNode;
  children: ReactNode;
  /** header/body/footer/container 的部分样式会与壳默认值合并 */
  styles?: {
    container?: CSSProperties;
    header?: CSSProperties;
    body?: CSSProperties;
    footer?: CSSProperties;
  };
  className?: string;
  destroyOnHidden?: boolean;
  closeIcon?: ReactNode;
  centered?: boolean;
  style?: CSSProperties;
  /** 显式指定 zIndex（默认由 layer depth 推导）。Drawer 等非 layer 容器内使用时传入更高值。 */
  zIndex?: number;
  /** 弹窗打开/关闭动画结束后的回调，用于自定义焦点管理 */
  afterOpenChange?: (open: boolean) => void;
  /** 贴边布局（如资产库三栏）：内容自行管理间距，去掉默认的顶部 pt-4 内边距。 */
  flush?: boolean;
  /** 挂到 document.body 呈现全屏遮罩（如破坏性二次确认），而非嵌进父 layer。 */
  global?: boolean;
  /** 是否显示遮罩（头像裁剪等无遮罩场景关闭） */
  mask?: boolean;
}

/**
 * 全站弹窗壳语言（单一来源）：容器清零、三段自控内边距，
 * header 右侧 56px 避让关闭按钮、标题行中心统一 28px（关闭按钮得以一条规则定位）。
 * 调用方经 styles 传入的部分覆盖同字段默认值；
 * footer 为 null 的弹窗需自行给 body 补底部间距（壳默认 0，间距归 footer）。
 * padding 类 token 在 v6 为 Modal 内部 token，无法经 ConfigProvider 配置，故在此声明。
 */
function withShellStyles(styles?: AppModalProps["styles"]) {
  return {
    container: { padding: 0, ...styles?.container },
    header: { padding: "16px 56px 0 24px", borderBottom: "none", marginBottom: 0, ...styles?.header },
    body: { padding: "16px 24px 0", ...styles?.body },
    footer: { padding: "16px 24px 20px", margin: 0, ...styles?.footer },
  };
}

/** 通用弹窗 - 统一标题下边距 + 居中，所有功能弹窗都用这个。 */
export default function AppModal({
  title, open, onCancel, width = 520, footer, children, styles,
  className, destroyOnHidden, closeIcon, centered = true, style, zIndex: explicitZIndex, afterOpenChange,
  flush = false, global: isGlobal = false, mask,
}: AppModalProps) {
  const { parentContainer, overlayRef, overlayRoot, depth, zIndex } = useLayerParent();

  // antd 的 centered 用 vertical-align:middle 垂直居中，弹窗 top 几乎总是小数坐标；
  // 盒子与字形各自吸附设备像素网格，结果按钮文字偏上 1px。
  // top 按面板高度与外边距计算，移动端也落在同一整数像素网格。
  // 弹窗 DOM 由 Portal 延后挂载（effect 时机拿不到），故经 panelRef 回调驱动：
  // 挂载即测一次，之后 ResizeObserver 跟随内容/视口变化重测。
  const panelElRef = useRef<HTMLElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [snapTop, setSnapTop] = useState<number | null>(null);

  const snap = useCallback(() => {
    const box = panelElRef.current;
    const wrap = box?.parentElement;
    if (!box || !wrap) return;
    const marginTop = parseFloat(getComputedStyle(box).marginTop) || 0;
    const top = Math.max(0, Math.round((wrap.clientHeight - box.offsetHeight) / 2 - marginTop));
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
      title={title}
      open={open}
      onCancel={onCancel}
      width={width}
      footer={footer}
      className={className}
      destroyOnHidden={destroyOnHidden}
      closeIcon={closeIcon}
      afterOpenChange={afterOpenChange}
      mask={mask}
      getContainer={isGlobal ? () => document.body : parentContainer}
      zIndex={isGlobal ? (explicitZIndex ?? 1050) : (explicitZIndex ?? zIndex)}
      panelRef={centered ? attachPanel : undefined}
      style={centered && snapTop !== null ? { ...style, top: snapTop } : style}
      styles={withShellStyles(styles)}
    >
      <LayerContext.Provider value={{ overlayRoot, depth }}>
        {/* Content wrapper — creates a positioning context for the overlay-root */}
        <div data-layer-scope style={{ position: "relative" }}>
          {flush ? children : <div className="pt-4">{children}</div>}

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
