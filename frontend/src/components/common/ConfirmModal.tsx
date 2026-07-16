"use client";

import { Button } from "antd";
import { LayerModal } from "@/lib/layer";
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
    <LayerModal
      title={<span style={{ color: "var(--canvas-text)" }}>{title}</span>}
      open={open}
      onCancel={onCancel}
      centered
      width={380}
      destroyOnHidden
      styles={{
        header: { background: "var(--canvas-bg)", borderBottom: "none" },
        body: { background: "var(--canvas-bg)", padding: "20px 24px" },
      }}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            className="modal-cancel-btn"
            onClick={onCancel}
            style={{
              background: "var(--canvas-bg)",
              border: "1px solid var(--canvas-border)",
              color: "var(--canvas-text)",
              borderRadius: 8,
              height: 36,
            }}
          >
            {cancelText || (lang === "zh" ? "取消" : "Cancel")}
          </Button>
          <Button
            className="modal-save-btn"
            onClick={onOk}
            style={{
              background: "#fff",
              border: "1px solid var(--canvas-border)",
              color: "#1a1a1a",
              borderRadius: 8,
              height: 36,
              fontWeight: 500,
            }}
          >
            {okText || (lang === "zh" ? "确定" : "OK")}
          </Button>
        </div>
      }
    >
      <p style={{ color: "var(--canvas-text)", margin: 0 }}>{content}</p>
    </LayerModal>
  );
}
