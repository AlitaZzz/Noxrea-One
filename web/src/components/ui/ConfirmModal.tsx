/**
 * 通用二次确认弹窗。
 * 接收标题与正文文案，渲染取消 / 确定两个按钮，按钮文案缺省时按当前语言取默认值。
 */
"use client";

import { useRef } from "react";
import { useTranslation } from "react-i18next";

import AppButton from "@/components/ui/AppButton";
import AppModal from "@/components/ui/AppModal";

interface Props {
  open: boolean;
  title: string;
  content: string;
  okText?: string;
  cancelText?: string;
  /** 确定按钮进入加载态并阻止重复提交，用于异步 onOk。 */
  confirmLoading?: boolean;
  onOk: () => void;
  onCancel: () => void;
  /** 显式指定 zIndex（默认由 layer depth 推导）。Drawer 等非 layer 容器内使用时传更高值（如 1050）。 */
  zIndex?: number;
  /** 挂到 body 呈现全屏遮罩，打断底层上下文；默认跟随父 layer 嵌套挂载。 */
  global?: boolean;
}

export default function ConfirmModal({ open, title, content, okText, cancelText, confirmLoading, onOk, onCancel, zIndex, global: isGlobal = false }: Props) {
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
      global={isGlobal}
      flush
      className="app-dialog"
      afterOpenChange={handleAfterOpenChange}
      width={380}
      footer={
        <div className="app-dialog-footer">
          <AppButton onClick={onCancel} disabled={confirmLoading}>{cancelText || (lang === "zh" ? "取消" : "Cancel")}</AppButton>
          <AppButton variant="primary" loading={confirmLoading} onClick={onOk} autoFocus ref={okRef}>{okText || (lang === "zh" ? "确定" : "OK")}</AppButton>
        </div>
      }
    >
      <p className="app-dialog-text">{content}</p>
    </AppModal>
  );
}
