/**
 * 通用二次确认弹窗。
 * 接收标题与正文文案，渲染取消 / 确定两个按钮，按钮文案缺省时按当前语言取默认值。
 */
"use client";

import { useRef } from "react";
import { useTranslation } from "react-i18next";

import AppModal from "@/components/ui/AppModal";
import ModalButton from "@/components/ui/ModalButton";

interface Props {
  open: boolean;
  title: string;
  content: string;
  okText?: string;
  cancelText?: string;
  onOk: () => void;
  onCancel: () => void;
  /** 显式指定 zIndex（默认由 layer depth 推导）。Drawer 等非 layer 容器内使用时传更高值（如 1050）。 */
  zIndex?: number;
}

export default function ConfirmModal({ open, title, content, okText, cancelText, onOk, onCancel, zIndex }: Props) {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  const okRef = useRef<HTMLButtonElement>(null);

  // antd 打开动画结束默认聚焦关闭按钮，这里把焦点交回「确定」按钮
  const handleAfterOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setTimeout(() => okRef.current?.focus(), 0);
  };

  return (
    <AppModal
      title={title}
      open={open}
      onCancel={onCancel}
      zIndex={zIndex}
      afterOpenChange={handleAfterOpenChange}
      width={380}
      styles={{
        header: { background: "var(--canvas-bg)", borderBottom: "none" },
        body: { background: "var(--canvas-bg)", padding: "0 20px 16px" },
      }}
      footer={
        <div className="flex justify-end gap-2">
          <ModalButton onClick={onCancel}>{cancelText || (lang === "zh" ? "取消" : "Cancel")}</ModalButton>
          <ModalButton variant="primary" onClick={onOk} autoFocus ref={okRef}>{okText || (lang === "zh" ? "确定" : "OK")}</ModalButton>
        </div>
      }
    >
      <p style={{ color: "var(--canvas-text)", margin: 0 }}>{content}</p>
    </AppModal>
  );
}
