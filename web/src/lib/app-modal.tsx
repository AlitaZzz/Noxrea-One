"use client";

import type { ComponentProps,ReactNode } from "react";

import { LayerModal } from "@/components/overlays/layer";

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
}

/** 通用弹窗 — 统一标题下边距 + 居中，所有功能弹窗都用这个。 */
export default function AppModal({
  title, open, onCancel, width = 520, footer, children, styles,
  className, destroyOnHidden, closeIcon, centered, style,
}: AppModalProps) {
  return (
    <LayerModal
      title={title} open={open} onCancel={onCancel}
      width={width} centered footer={footer} styles={styles}
      className={className} destroyOnHidden={destroyOnHidden} closeIcon={closeIcon}
      style={style}
    >
      <div className="pt-4">{children}</div>
    </LayerModal>
  );
}
