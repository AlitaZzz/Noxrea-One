/**
 * 账户设置弹窗。
 * 展示当前登录用户的用户名（登录身份，不可修改），修改头像（经裁剪弹窗上传）与登录密码，
 * 保存后同步更新 auth store 中的用户信息。与模型 / 渠道配置无关。
 */

"use client";

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CameraOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
        if (!oldPw) { message.error(t("auth.oldPwRequired")); return; }
        body.password = newPw;
        body.oldPassword = oldPw;
      }
      if (Object.keys(body).length === 0) { message.info(t("auth.nothingToSave")); return; }
      const updated = await api<UserInfo>("/api/auth/me", { method: "PUT", body: JSON.stringify(body) });
      // 保存失败时 api() 抛 ApiError，由外层 catch 提示且不关弹窗
      if (!updated) { message.error(t("auth.saveFailed")); return; }
      useAuthStore.setState({ user: updated }); // immediate update, no refetch needed
      message.success(t("common.saved"));
      onClose();
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : t("auth.saveFailed")); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <DialogHeader className="border-b bg-muted/20 px-6 py-6">
          <DialogTitle>{t("auth.accountSettings")}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[min(720px,calc(100vh-8rem))] overflow-y-auto px-6 py-6">
          <section className="flex items-center gap-4 rounded-lg border border-border bg-muted/20 p-4">
            <Button
              type="button"
              variant="default"
              className="group relative size-24 shrink-0 overflow-hidden rounded-full p-0 text-3xl font-bold ring-1 ring-border hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => fileRef.current?.click()}
              aria-label={t("auth.clickUpload")}
            >
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                user?.username?.[0]?.toUpperCase() || "U"
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <CameraOutlined className="text-lg" />
              </span>
            </Button>
            <div className="min-w-0 space-y-1">
              <div className="truncate text-sm font-medium text-foreground">{user?.username || t("auth.defaultUser")}</div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) {
                  setCropFile(f);
                  setCropOpen(true);
                }
              }}
            />
          </section>

          <section className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="settings-username" className="text-xs text-muted-foreground">{t("auth.username")}</Label>
              <Input id="settings-username" value={user?.username ?? ""} disabled />
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="settings-current-password" className="text-xs text-muted-foreground">{t("auth.currentPassword")}</Label>
                <PasswordInput
                  id="settings-current-password"
                  placeholder={t("auth.oldPwRequired")}
                  value={oldPw}
                  onChange={(e) => setOldPw(e.target.value)}
                  showLabel={t("auth.login.showPassword")}
                  hideLabel={t("auth.login.hidePassword")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="settings-new-password" className="text-xs text-muted-foreground">{t("auth.newPassword")}</Label>
                <PasswordInput
                  id="settings-new-password"
                  placeholder={t("auth.keepBlank")}
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  showLabel={t("auth.login.showPassword")}
                  hideLabel={t("auth.login.hidePassword")}
                />
              </div>
            </div>
          </section>
        </div>
        <DialogFooter className="border-t bg-muted/20 px-6 py-4 sm:justify-end">
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={saving}>{t("common.cancel")}</Button>
          </DialogClose>
          <Button type="button" variant="default" onClick={handleSave} loading={saving}>{t("auth.saveChanges")}</Button>
        </DialogFooter>
        <AvatarCropModal open={cropOpen} file={cropFile} onDone={(url) => { setAvatarUrl(url); setCropOpen(false); }} onClose={() => setCropOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
