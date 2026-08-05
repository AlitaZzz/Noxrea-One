/**
 * 通用二次确认弹窗。
 * 接收标题与正文文案，渲染取消 / 确定两个按钮，按钮文案缺省时按当前语言取默认值。
 */
"use client";

import ModalButton from "@/components/common/ModalButton";
import AppModal from "@/components/common/AppModal";
import { useI18nStore } from "@/stores/i18n-store";

interface Props {
  open: boolean;
  title: string;
  content: string;
  okText?: string;
  cancelText?: string;
  onOk: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({ open, title, content, okText, cancelText, onOk, onCancel }: Props) {
  const lang = useI18nStore((s) => s.lang);

  return (
    <AppModal
      title={title}
      open={open}
      onCancel={onCancel}
      width={380}
      styles={{
        header: { background: "var(--canvas-bg)", borderBottom: "none" },
        body: { background: "var(--canvas-bg)", padding: "20px 24px" },
      }}
      footer={
        <div className="flex justify-end gap-2">
          <ModalButton onClick={onCancel}>{cancelText || (lang === "zh" ? "取消" : "Cancel")}</ModalButton>
          <ModalButton variant="primary" onClick={onOk}>{okText || (lang === "zh" ? "确定" : "OK")}</ModalButton>
        </div>
      }
    >
      <p style={{ color: "var(--canvas-text)", margin: 0 }}>{content}</p>
    </AppModal>
  );
}
