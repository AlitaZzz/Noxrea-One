"use client";

import { useState } from "react";
import { Input } from "antd";
import AppModal from "@/lib/app-modal";
import ModalButton from "@/components/common/ModalButton";
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
    <AppModal
      title={t("asset.createFolder")}
      open={open}
      onCancel={() => { setName(""); setError(""); onClose(); }}
      width={400}
      destroyOnHidden
      styles={{
        header: { background: "var(--canvas-bg)", borderBottom: "none" },
        body: { background: "var(--canvas-bg)", padding: "20px 24px" },
      }}
      footer={
        <div className="flex justify-end gap-2">
          <ModalButton onClick={() => { setName(""); onClose(); }}>{t("cancel")}</ModalButton>
          <ModalButton variant="primary" onClick={handleCreate} disabled={!name.trim()}>{t("save")}</ModalButton>
        </div>
      }
    >
      <style>{`
        .ant-input:hover, .ant-input:focus,
        .ant-input-affix-wrapper:hover, .ant-input-affix-wrapper:focus {
          border-color: var(--canvas-border) !important;
          box-shadow: none !important;
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
    </AppModal>
  );
}
