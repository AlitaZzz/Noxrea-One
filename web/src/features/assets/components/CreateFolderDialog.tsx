/**
 * 新建文件夹弹窗。
 * 仅收集文件夹名称并回调创建，重名等失败情况由父级返回布尔值后在此提示。
 */
"use client";

import { Input } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import AppModal from "@/components/ui/AppModal";
import ModalButton from "@/components/ui/ModalButton";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<boolean>;
}

export default function CreateFolderDialog({ open, onClose, onCreate }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    const ok = await onCreate(name.trim());
    setSaving(false);
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
          <ModalButton onClick={() => { setName(""); onClose(); }}>{t("common.cancel")}</ModalButton>
          <ModalButton variant="primary" onClick={handleCreate} disabled={!name.trim() || saving}>{t("common.save")}</ModalButton>
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
