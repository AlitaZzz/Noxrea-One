/**
 * 账户设置弹窗。
 * 修改当前登录用户的头像（经裁剪弹窗上传）、昵称与登录密码，
 * 保存后同步更新 auth store 中的用户信息。与模型 / 渠道配置无关。
 */
"use client";

import { CameraOutlined,LockOutlined, UserOutlined } from "@ant-design/icons";
import { App,Button, Input } from "antd";
import { useEffect, useRef,useState } from "react";
import { useTranslation } from "react-i18next";

import AppModal from "@/components/ui/AppModal";
import { EyeIcon } from "@/components/ui/icons/common/EyeIcon";
import { EyeOffIcon } from "@/components/ui/icons/common/EyeOffIcon";
import { useAuthStore, type UserInfo } from "@/features/auth/store";
import { api } from "@/lib/api/client";

import AvatarCropModal from "./AvatarCropModal";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsModal({ open, onClose }: Props) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const user = useAuthStore((s) => s.user);
  const fileRef = useRef<HTMLInputElement>(null);

  const [nick, setNick] = useState("");
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
      setNick(user.username || "");
      setAvatarUrl(user.avatarUrl || "");
      setOldPw("");
      setNewPw("");
    }
  }

  const is = { background: "var(--canvas-bg-elevated)", border: "1px solid var(--canvas-border-light)", color: "var(--canvas-text)", borderRadius: 8 };


  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, string> = {};
      if (nick.trim() && nick.trim() !== user?.username) body.username = nick.trim();
      if (avatarUrl.trim() && avatarUrl !== user?.avatarUrl) body.avatarUrl = avatarUrl.trim();
      if (newPw.trim()) {
        if (!oldPw) { message.error(t("auth.oldPwRequired")); setSaving(false); return; }
        body.password = newPw;
        body.oldPassword = oldPw;
      }
      if (Object.keys(body).length === 0) { message.info(t("auth.nothingToSave")); setSaving(false); return; }
      const res = await api<UserInfo>("/api/auth/me", { method: "PUT", body: JSON.stringify(body) });
      if (res.code === 200 && res.data) {
        useAuthStore.setState({ user: res.data }); // immediate update, no refetch needed
      }
      message.success(t("common.saved"));
      onClose();
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : t("auth.saveFailed")); }
    setSaving(false);
  };

  return (
    <AppModal
      title={t("auth.accountSettings")}
      open={open}
      onCancel={onClose}
      footer={null}
      width={400}
      styles={{
        header: { background: "var(--canvas-bg)", borderBottom: "none" },
        body: { background: "var(--canvas-bg)", padding: "24px" },
      }}
    >
      <div className="flex flex-col gap-4">
        {/* Avatar */}
        <div className="flex flex-col items-center gap-2">
          <div
            className="w-32 h-32 rounded-full flex items-center justify-center text-4xl font-bold cursor-pointer relative group hover:opacity-80 transition-opacity"
            style={{ background: "#1677ff", color: "#fff" }}
            onClick={() => fileRef.current?.click()}
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full rounded-full object-cover" />
            ) : (
              nick[0]?.toUpperCase() || "U"
            )}
            <div className="absolute inset-0 rounded-full bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <CameraOutlined style={{ fontSize: 18 }} />
            </div>
          </div>
          <span className="text-xs" style={{ color: "var(--canvas-text-muted)" }}>{t("auth.clickUpload")}</span>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setCropFile(f); setCropOpen(true); } }} />
        </div>

        {/* Nickname */}
        <div>
          <div className="text-xs font-medium mb-1.5" style={{ color: "var(--canvas-text-dim)" }}>{t("auth.nickname")}</div>
          <Input prefix={<UserOutlined style={{ color: "var(--canvas-text-dim)" }} />} value={nick} onChange={(e) => setNick(e.target.value)} style={is} />
        </div>

        {/* Old Password */}
        <div>
          <div className="text-xs font-medium mb-1.5" style={{ color: "var(--canvas-text-dim)" }}>{t("auth.currentPassword")}</div>
          <Input.Password prefix={<LockOutlined style={{ color: "var(--canvas-text-dim)" }} />} placeholder={t("auth.oldPwRequired")} value={oldPw} onChange={(e) => setOldPw(e.target.value)} style={is}
            iconRender={(v) => (v ? <EyeIcon style={{ color: "var(--canvas-text)" }} /> : <EyeOffIcon style={{ color: "var(--canvas-text)" }} />)} />
        </div>

        {/* New Password */}
        <div>
          <div className="text-xs font-medium mb-1.5" style={{ color: "var(--canvas-text-dim)" }}>{t("auth.newPassword")}</div>
          <Input.Password prefix={<LockOutlined style={{ color: "var(--canvas-text-dim)" }} />} placeholder={t("auth.keepBlank")} value={newPw} onChange={(e) => setNewPw(e.target.value)} style={is}
            iconRender={(v) => (v ? <EyeIcon style={{ color: "var(--canvas-text)" }} /> : <EyeOffIcon style={{ color: "var(--canvas-text)" }} />)} />
        </div>

        <Button type="primary" size="large" onClick={handleSave} loading={saving} block>
          {t("auth.saveChanges")}
        </Button>
      </div>
      <AvatarCropModal open={cropOpen} file={cropFile} onDone={(url) => { setAvatarUrl(url); setCropOpen(false); }} onClose={() => setCropOpen(false)} />
    </AppModal>
  );
}
