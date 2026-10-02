/**
 * 账户设置弹窗。
 * 展示当前登录用户的用户名（登录身份，不可修改），修改头像（经裁剪弹窗上传）与登录密码，
 * 保存后同步更新 auth store 中的用户信息。与模型 / 渠道配置无关。
 */

"use client";

import { useRef,useState } from "react";
import { useTranslation } from "react-i18next";

import { CameraOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { useAuthStore } from "@/features/auth/store";
import { type UserInfo } from "@/features/auth/user-cache";
import { api } from "@/lib/api/client";

import AvatarCropModal from "./AvatarCropModal";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsModal({ open, onClose }: Props) {
  const { t } = useTranslation();
  const { message } = useAppFeedback();
  const user = useAuthStore((s) => s.user);
  const fileRef = useRef<HTMLInputElement>(null);

  const [avatarUrl, setAvatarUrl] = useState("");
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Resync form fields from user when the modal (re)opens, adjusted during
  // render to avoid cascading renders from the effect.
  const [prevUserKey, setPrevUserKey] = useState<number | null>(null);
  const userKey = open && user ? (user.id ?? null) : null;
  if (userKey !== prevUserKey) {
    setPrevUserKey(userKey);
    if (userKey !== null && user) {
      setAvatarUrl(user.avatarUrl || "");
      setOldPw("");
      setNewPw("");
    }
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, string> = {};
      if (avatarUrl.trim() && avatarUrl !== user?.avatarUrl) body.avatarUrl = avatarUrl.trim();
      if (newPw.trim()) {
        if (!oldPw) { message.error(t("auth.oldPwRequired")); setSaving(false); return; }
        body.password = newPw;
        body.oldPassword = oldPw;
      }
      if (Object.keys(body).length === 0) { message.info(t("auth.nothingToSave")); setSaving(false); return; }
      const updated = await api<UserInfo>("/api/auth/me", { method: "PUT", body: JSON.stringify(body) });
      // 保存失败时 api() 抛 ApiError，由外层 catch 提示且不关弹窗
      if (!updated) { message.error(t("auth.saveFailed")); return; }
      useAuthStore.setState({ user: updated }); // immediate update, no refetch needed
      message.success(t("common.saved"));
      onClose();
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : t("auth.saveFailed")); }
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent className="sm:max-w-[400px] bg-card">
        <DialogHeader>
          <DialogTitle>{t("auth.accountSettings")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
        {/* Avatar */}
        <div className="flex flex-col items-center gap-2">
          <div
            className="w-32 h-32 rounded-full flex items-center justify-center text-4xl font-bold cursor-pointer relative group hover:opacity-80 transition-opacity"
            style={{ background: "var(--primary)", color: "var(--background)" }}
            onClick={() => fileRef.current?.click()}
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full rounded-full object-cover" />
            ) : (
              user?.username?.[0]?.toUpperCase() || "U"
            )}
            <div className="absolute inset-0 rounded-full bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <CameraOutlined style={{ fontSize: 18 }} />
            </div>
          </div>
          <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>{t("auth.clickUpload")}</span>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setCropFile(f); setCropOpen(true); } }} />
        </div>

        {/* Username（登录身份，不可修改） */}
        <div>
          <div className="text-xs font-medium mb-1.5" style={{ color: "var(--muted-foreground)" }}>{t("auth.username")}</div>
          <Input value={user?.username ?? ""} disabled />
        </div>

        {/* Old Password */}
        <div>
          <div className="text-xs font-medium mb-1.5" style={{ color: "var(--muted-foreground)" }}>{t("auth.currentPassword")}</div>
          <PasswordInput placeholder={t("auth.oldPwRequired")} value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
        </div>

        {/* New Password */}
        <div>
          <div className="text-xs font-medium mb-1.5" style={{ color: "var(--muted-foreground)" }}>{t("auth.newPassword")}</div>
          <PasswordInput placeholder={t("auth.keepBlank")} value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        </div>

        <Button variant="primary" size="md" onClick={handleSave} loading={saving} block>
          {t("auth.saveChanges")}
        </Button>
        </div>
        <AvatarCropModal open={cropOpen} file={cropFile} onDone={(url) => { setAvatarUrl(url); setCropOpen(false); }} onClose={() => setCropOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
