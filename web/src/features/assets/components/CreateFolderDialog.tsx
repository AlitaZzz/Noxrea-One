/**
 * 新建文件夹弹窗。
 * 仅收集文件夹名称并回调创建，重名等失败情况由父级返回布尔值后在此提示。
 */

"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<"created" | "duplicate" | "failed">;
}

export default function CreateFolderDialog({ open, onClose, onCreate }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    const status = await onCreate(name.trim());
    setSaving(false);
    if (status === "created") {
      setName("");
      setError("");
      onClose();
    } else if (status === "duplicate") {
      setError(t("asset.folderDuplicate"));
    } else {
      // 服务端失败的具体原因已由 store 统一通知，这里只给行内反馈。
      setError(t("error.asset.folder_create_failed"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) { setName(""); setError(""); onClose(); }
    }}>
      <DialogContent global className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t("asset.createFolder")}</DialogTitle>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <Label htmlFor="asset-folder-name">{t("asset.folderName")}</Label>
            <Input
              id="asset-folder-name"
              value={name}
              onChange={(e) => { setName(e.target.value.slice(0, 20)); setError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); }}
              placeholder={t("asset.folderNamePlaceholder")}
              maxLength={20}
              aria-invalid={error ? true : undefined}
            />
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              {error ? <p className="text-destructive">{error}</p> : <span />}
              <span>{name.length} / 20</span>
            </div>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={saving}>{t("common.cancel")}</Button>
          </DialogClose>
          <Button onClick={handleCreate} disabled={!name.trim() || saving}>{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
