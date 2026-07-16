"use client";

import { useState } from "react";
import { Input, Button } from "antd";
import { LayerModal } from "@/lib/layer";
import { useI18nStore } from "@/stores/i18n-store";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => boolean;
}

export default function CreateFolderDialog({ open, onClose, onCreate }: Props) {
  const t = useI18nStore((s) => s.t);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const handleCreate = () => {
    if (!name.trim()) return;
    const ok = onCreate(name.trim());
    if (ok) {
      setName("");
      setError("");
      onClose();
    } else {
      setError(t("asset.folderDuplicate"));
    }
  };

  return (
    <LayerModal
      title={<span style={{ color: "var(--canvas-text)", fontSize: 16, fontWeight: 600 }}>{t("asset.createFolder")}</span>}
      open={open}
      onCancel={() => { setName(""); setError(""); onClose(); }}
      className="asset-dialog"
      footer={
        <div className="flex justify-end gap-2 pt-4">
          <Button
            className="modal-cancel-btn"
            onClick={() => { setName(""); onClose(); }}
            style={{
              height: 36,
              background: "var(--canvas-bg)",
              border: "1px solid var(--canvas-border)",
              color: "var(--canvas-text)",
              borderRadius: 8,
            }}
          >
            {t("cancel")}
          </Button>
          <Button
            className="modal-save-btn"
            onClick={handleCreate}
            disabled={!name.trim()}
            style={{
              height: 36,
              background: "#fff",
              border: "1px solid var(--canvas-border)",
              color: "#1a1a1a",
              borderRadius: 8,
              fontWeight: 500,
            }}
          >
            {t("save")}
          </Button>
        </div>
      }
      width={400}
      centered
      destroyOnHidden
      styles={{
        header: { background: "var(--canvas-bg)", borderBottom: "none", paddingBottom: 12 },
        body: { background: "var(--canvas-bg)", padding: "20px 24px 8px" },
        footer: { background: "var(--canvas-bg)", borderTop: "none", paddingTop: 0 },
      }}
      closeIcon={<span style={{ color: "var(--canvas-text-secondary)" }}>✕</span>}
    >
      <style>{`
        .asset-dialog .ant-input:hover,
        .asset-dialog .ant-input:focus,
        .asset-dialog .ant-input-affix-wrapper:hover,
        .asset-dialog .ant-input-affix-wrapper:focus {
          border-color: var(--canvas-border) !important;
          box-shadow: none !important;
        }
        .asset-dialog .folder-save-btn:not(:disabled):hover {
          background: #e6e6e6 !important;
        }
      `}</style>
      <Input
        value={name}
        onChange={(e) => { setName(e.target.value.slice(0, 20)); setError(""); }}
        onPressEnter={handleCreate}
        placeholder={t("asset.folderNamePlaceholder")}
        maxLength={20}
        showCount
        status={error ? "error" : undefined}
        style={{
          background: "var(--canvas-bg-elevated)",
          borderColor: error ? "#ff4d4f" : "var(--canvas-border)",
          color: "var(--canvas-text)",
        }}
      />
      {error && (
        <div className="text-xs mt-1.5" style={{ color: "#ff4d4f" }}>{error}</div>
      )}
    </LayerModal>
  );
}
