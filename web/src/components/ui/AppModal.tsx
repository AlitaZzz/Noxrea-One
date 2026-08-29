/**
 * 通用弹窗基座。
 * 在 LayerModal 之上统一居中、宽度默认值与标题下边距，全站功能弹窗均基于它构建。
 */
"use client";

import type { ComponentProps,ReactNode } from "react";

import { LayerModal } from "@/components/ui/modal/LayerModal";

interface AppModalProps {
  title: ReactNode;
  open: boolean;
  onCancel: () => void;
  width?: number | string;
  footer?: ReactNode;
  children: ReactNode;
  /** 透传给 LayerModal */
  styles?: ComponentProps<typeof LayerModal>["styles"];
  className?: string;
  destroyOnHidden?: boolean;
  closeIcon?: ReactNode;
  centered?: boolean;
  style?: React.CSSProperties;
  /** 显式指定 zIndex（默认由 layer depth 推导）。Drawer 等非 layer 容器内使用时传入更高值。 */
  zIndex?: number;
}

/** 通用弹窗 - 统一标题下边距 + 居中，所有功能弹窗都用这个。 */
export default function AppModal({
  title, open, onCancel, width = 520, footer, children, styles,
  className, destroyOnHidden, closeIcon, centered, style, zIndex,
}: AppModalProps) {
  return (
    <LayerModal
      title={title} open={open} onCancel={onCancel}
      width={width} centered footer={footer} styles={styles}
      className={className} destroyOnHidden={destroyOnHidden} closeIcon={closeIcon}
      style={style} zIndex={zIndex}
    >
      <div className="pt-4">{children}</div>
    </LayerModal>
  );
}
