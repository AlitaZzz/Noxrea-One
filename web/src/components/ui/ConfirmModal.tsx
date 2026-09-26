/**
 * 通用二次确认弹窗。
 * 接收标题与正文文案，渲染取消 / 确定两个按钮，按钮文案缺省时取 i18n 默认值。
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
  /** 只保留确定按钮（无取消语义的强制流程，如会话过期）；Esc / 遮罩关闭同样走 onCancel。 */
  hideCancel?: boolean;
  onOk: () => void;
  onCancel: () => void;
  /** 显式指定 zIndex（默认由 layer depth 推导）。Drawer 等非 layer 容器内使用时传更高值（如 1050）。 */
  zIndex?: number;
  /** 挂到 body 呈现全屏遮罩，打断底层上下文；默认跟随父 layer 嵌套挂载。 */
  global?: boolean;
}

export default function ConfirmModal({ open, title, content, okText, cancelText, confirmLoading, hideCancel, onOk, onCancel, zIndex, global: isGlobal = false }: Props) {
  const { t } = useTranslation();
  const okRef = useRef<HTMLButtonElement>(null);

  // 焦点必须等 antd 打开动画结束、rc-dialog 的焦点管理收尾后再交回「确定」，
  // 挂载期 autoFocus 会被 rc-dialog 抢走，故只在 afterOpenChange 里显式聚焦
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
          {!hideCancel && <AppButton onClick={onCancel} disabled={confirmLoading}>{cancelText ?? t("common.cancel")}</AppButton>}
          <AppButton variant="primary" loading={confirmLoading} onClick={onOk} ref={okRef}>{okText ?? t("common.confirm")}</AppButton>
        </div>
      }
    >
      <p className="app-dialog-text">{content}</p>
    </AppModal>
  );
}
