"use client";

import { CameraOutlined,LockOutlined, UserOutlined } from "@ant-design/icons";
import { App,Button, Input } from "antd";
import { useEffect, useRef,useState } from "react";

import { api } from "@/lib/api";
import AppModal from "@/lib/app-modal";
import { useAuthStore, type UserInfo } from "@/stores/auth-store";
import { useI18nStore } from "@/stores/i18n-store";

import AvatarCropModal from "./AvatarCropModal";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsModal({ open, onClose }: Props) {
  const t = useI18nStore((s) => s.t);
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
        if (!oldPw) { message.error(t("old.pw.required")); setSaving(false); return; }
        body.password = newPw;
        body.oldPassword = oldPw;
      }
      if (Object.keys(body).length === 0) { message.info(t("nothing.to.save")); setSaving(false); return; }
      const res = await api<UserInfo>("/api/auth/me", { method: "PUT", body: JSON.stringify(body) });
      if (res.code === 200 && res.data) {
        useAuthStore.setState({ user: res.data }); // immediate update, no refetch needed
      }
      message.success(t("saved"));
      onClose();
    } catch (e: unknown) { message.error(e instanceof Error ? e.message : t("save.failed")); }
    setSaving(false);
  };

  return (
    <AppModal
      title={t("account.settings")}
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
          <span className="text-xs" style={{ color: "var(--canvas-text-muted)" }}>{t("click.upload")}</span>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setCropFile(f); setCropOpen(true); } }} />
        </div>

        {/* Nickname */}
        <div>
          <div className="text-xs font-medium mb-1.5" style={{ color: "var(--canvas-text-dim)" }}>{t("nickname")}</div>
          <Input prefix={<UserOutlined style={{ color: "var(--canvas-text-dim)" }} />} value={nick} onChange={(e) => setNick(e.target.value)} style={is} />
        </div>

        {/* Old Password */}
        <div>
          <div className="text-xs font-medium mb-1.5" style={{ color: "var(--canvas-text-dim)" }}>{useI18nStore.getState().lang === "zh" ? "当前密码" : "Current Password"}</div>
          <Input.Password prefix={<LockOutlined style={{ color: "var(--canvas-text-dim)" }} />} placeholder={useI18nStore.getState().lang === "zh" ? "修改密码需输入当前密码" : "Required to change password"} value={oldPw} onChange={(e) => setOldPw(e.target.value)} style={is}
            iconRender={(v) => (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--canvas-text)" }}>
                    {v ? (<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>) : (<><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></>)}
                  </svg>
                )} />
        </div>

        {/* New Password */}
        <div>
          <div className="text-xs font-medium mb-1.5" style={{ color: "var(--canvas-text-dim)" }}>{useI18nStore.getState().lang === "zh" ? "新密码（留空保持不变）" : "New Password (leave blank to keep)"}</div>
          <Input.Password prefix={<LockOutlined style={{ color: "var(--canvas-text-dim)" }} />} placeholder={useI18nStore.getState().lang === "zh" ? "留空保持不变" : "Leave blank"} value={newPw} onChange={(e) => setNewPw(e.target.value)} style={is}
            iconRender={(v) => (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--canvas-text)" }}>
                    {v ? (<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>) : (<><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></>)}
                  </svg>
                )} />
        </div>

        <Button type="primary" size="large" onClick={handleSave} loading={saving} block>
          {t("save.changes")}
        </Button>
      </div>
      <AvatarCropModal open={cropOpen} file={cropFile} onDone={(url) => { setAvatarUrl(url); setCropOpen(false); }} onClose={() => setCropOpen(false)} />
    </AppModal>
  );
}
