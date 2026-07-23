"use client";

import { ClockCircleOutlined,DeleteOutlined, EditOutlined, FolderOpenOutlined, PlusOutlined } from "@ant-design/icons";
import { Popover } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import SettingsModal from "@/components/auth/SettingsModal";
import ConfirmModal from "@/components/common/ConfirmModal";
import { MenuDivider,MenuItem, MenuPopover } from "@/components/common/MenuPopover";
import type { CanvasProject } from "@/lib/types";
import { useAuthStore } from "@/stores/auth-store";
import { useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";
import { useProjectStore } from "@/stores/project-store";

export default function ProjectPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CanvasProject | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const renameProject = useProjectStore((s) => s.renameProject);
  const user = useAuthStore((s) => s.user);
  const theme = useCanvasStore((s) => s.theme);
  const toggleTheme = useCanvasStore((s) => s.toggleTheme);
  const i18n = useI18nStore((s) => s);
  const t = useI18nStore((s) => s.t);
  const initialize = useProjectStore((s) => s.initialize);
  const projects = useProjectStore((s) => s.projects);
  const createProject = useProjectStore((s) => s.createProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);

  useEffect(() => {
    useAuthStore.getState().initialize().then(() => {
      if (!useAuthStore.getState().user) { window.location.href = "/login"; return; }
      const u = useAuthStore.getState().user!;
      useCanvasStore.getState().setTheme(u.theme === "light" ? "light" : "dark");
      useI18nStore.getState().setLang((u.lang || "zh") as "zh" | "en");
      initialize().then(() => setReady(true));
    });
  }, [initialize]);

  const handleOpen = (p: CanvasProject) => {
    setActiveProject(p.id);
    router.push("/canvas");
  };


  const handleCreate = async () => {
    const p = await createProject();
    setActiveProject(p.id);
    router.push("/canvas");
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-screen" style={{ background: "var(--canvas-app-bg)" }}>
        <div className="text-sm" style={{ color: "var(--canvas-text-dim)" }}>Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 md:p-10" style={{ background: "var(--canvas-app-bg)", color: "var(--canvas-text)" }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-8 max-w-6xl mx-auto">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold m-0">{t("all.projects")}</h1>
          <span className="text-sm" style={{ color: "var(--canvas-text-dim)" }}>{projects.length}</span>
        </div>

        <Popover
          content={
            <div className="flex flex-col p-2 gap-0.5" style={{ margin: -12, background: "var(--canvas-bg)", borderRadius: 8, minWidth: 180 }}>
              <style>{`.avatar-menu-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
              <div className="flex items-center gap-2 px-1 py-1.5">
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold overflow-hidden" style={{ background: "#1677ff", color: "#fff" }}>
                  {user?.avatar ? <img src={user.avatar} alt="" className="w-full h-full object-cover" /> : (user?.username || "U")[0].toUpperCase()}
                </div>
                <span className="text-sm font-medium" style={{ color: "var(--canvas-text)" }}>{user?.username}</span>
              </div>
              <div style={{ height: 1, background: "var(--canvas-border)", margin: "2px 6px" }} />
              <button className="avatar-menu-item text-left px-3 py-1.5 text-sm rounded transition-colors"
                style={{ color: "var(--canvas-text)", border: "none", cursor: "pointer", background: "transparent" }}
                onClick={() => { setAvatarOpen(false); setSettingsOpen(true); }}>
                {t("account.settings")}
              </button>
              <div style={{ height: 1, background: "var(--canvas-border)", margin: "2px 6px" }} />
              <button className="avatar-menu-item text-left px-3 py-1.5 text-sm rounded transition-colors flex items-center gap-2"
                style={{ color: "var(--canvas-text)", border: "none", cursor: "pointer", background: "transparent", width: "100%" }}
                onClick={() => { i18n.toggle(); useAuthStore.getState().savePreference("lang", i18n.lang === "zh" ? "en" : "zh"); setAvatarOpen(false); }}>
<span>{i18n.lang === "zh" ? "简体中文" : "English"}</span><span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, opacity: 0.6 }}>{i18n.lang === "zh" ? "中" : "EN"}</span>
              </button>
              <button className="avatar-menu-item text-left px-3 py-1.5 text-sm rounded transition-colors flex items-center gap-2"
                style={{ color: "var(--canvas-text)", border: "none", cursor: "pointer", background: "transparent", width: "100%" }}
                onClick={() => { const next = theme === "dark" ? "light" : "dark"; toggleTheme(); useAuthStore.getState().savePreference("theme", next); setAvatarOpen(false); }}>
{theme === "dark" ? (
                  <><span>{t("theme.dark")}</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginLeft: "auto" }}><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg></>
                ) : (
                  <><span>{t("theme.light")}</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginLeft: "auto" }}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></>
                )}
              </button>
              <div style={{ height: 1, background: "var(--canvas-border)", margin: "2px 6px" }} />
              <button className="avatar-menu-item text-left px-3 py-1.5 text-sm rounded transition-colors"
                style={{ color: "var(--canvas-text-dim)", border: "none", cursor: "pointer", background: "transparent" }}
                onClick={() => { useAuthStore.getState().logout(); router.push("/login"); }}>
                {t("logout")}
              </button>
            </div>
          }
          trigger="click"
          placement="bottomRight"
          open={avatarOpen}
          onOpenChange={setAvatarOpen}
        >
          <div className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity rounded-lg px-2 py-1" style={{ background: "var(--canvas-bg-elevated)" }}>
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold overflow-hidden" style={{ background: "#1677ff", color: "#fff" }}>
              {user?.avatar ? (
                <img src={user.avatar} alt="" className="w-full h-full object-cover" />
              ) : (
                (user?.username || "U")[0].toUpperCase()
              )}
            </div>
            <span className="text-sm font-medium" style={{ color: "var(--canvas-text)" }}>{user?.username || "User"}</span>
            <svg width="10" height="10" viewBox="0 0 16 16" style={{ color: "var(--canvas-text-dim)" }}>
              <g transform="translate(4.7 5.8)"><path d="M6.2 0.1C6.36-0.06 6.61-0.06 6.77 0.1L7.19 0.52C7.35 0.68 7.35 0.93 7.19 1.09L4.15 4.13C3.87 4.4 3.43 4.4 3.16 4.13L0.12 1.09C-0.04 0.93-0.04 0.68 0.12 0.52L0.54 0.1C0.7-0.07 0.95-0.07 1.11 0.1L3.65 2.64L6.2 0.1Z" fill="currentColor"/></g>
            </svg>
          </div>
        </Popover>
      </div>

      {/* Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 max-w-6xl mx-auto">
          {/* Create new project card — always first */}
          <div
            className="rounded-xl border border-dashed cursor-pointer transition-all hover:shadow-lg hover:-translate-y-0.5 flex flex-col items-center justify-center"
            style={{
              background: "var(--canvas-bg)",
              borderColor: "var(--canvas-border)",
              aspectRatio: "1 / 1",
            }}
            onClick={handleCreate}
          >
            <PlusOutlined className="text-3xl mb-2" style={{ color: "var(--canvas-text-dim)" }} />
            <span className="text-sm" style={{ color: "var(--canvas-text-dim)" }}>{t("new.project")}</span>
          </div>

          {projects.map((p) => (
            <div
              key={p.id}
              className="group relative rounded-xl border cursor-pointer transition-all hover:shadow-lg hover:-translate-y-0.5"
              style={{
                background: "var(--canvas-bg)",
                borderColor: "var(--canvas-border)",
              }}
              onClick={() => handleOpen(p)}
            >
              {/* Preview area */}
              <div
                className="aspect-video rounded-t-xl flex items-center justify-center overflow-hidden"
                style={{ background: "var(--canvas-bg-elevated)" }}
              >
                {(() => {
                  const imgNode = (p.nodes || []).find(
                    (n) => n.type === "image-node" && (n.data as { src?: string })?.src
                  );
                  if (imgNode) {
                    return <img src={(imgNode.data as { src?: string }).src} alt="" className="w-full h-full object-cover" />;
                  }
                  return <FolderOpenOutlined className="text-3xl" style={{ color: "var(--canvas-text-muted)" }} />;
                })()}
              </div>

              {/* Info */}
              <div className="p-3">
                <div className="flex items-center justify-between gap-2">
                  {editingId === p.id ? (
                    <input
                      className="text-sm font-medium bg-transparent border rounded px-1.5 py-0.5 flex-1 min-w-0 outline-none"
                      style={{ color: "var(--canvas-text)", borderColor: "var(--canvas-border)" }}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onBlur={() => { if (editName.trim()) renameProject(p.id, editName.trim()); setEditingId(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <div className="text-sm font-medium truncate flex-1">{p.name}</div>
                  )}
                  <div className="flex gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button
                      style={{ background: "var(--canvas-bg-hover)", border: "none", cursor: "pointer", width: 26, height: 26, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--canvas-text-dim)" }}
                      onClick={() => { setEditingId(p.id); setEditName(p.name); }}>
                      <EditOutlined style={{ fontSize: 12 }} />
                    </button>
                    <button
                      style={{ background: "var(--canvas-bg-hover)", border: "none", cursor: "pointer", width: 26, height: 26, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--canvas-text-dim)" }}
                      onClick={() => setDeleteTarget(p)}>
                      <DeleteOutlined style={{ fontSize: 12 }} />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-1 mt-1.5 text-xs" style={{ color: "var(--canvas-text-muted)" }}>
                  <ClockCircleOutlined className="text-[10px]" />
                  {formatDate(p.updatedAt)}
                </div>
                <div className="text-xs mt-0.5" style={{ color: "var(--canvas-text-muted)" }}>
                  {p.nodes?.length || 0}{t("nodes.count")}
                </div>
              </div>
            </div>
          ))}
        </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <ConfirmModal
        open={!!deleteTarget}
        title={t("delete.project")}
        content={`${t("project.delete.confirm")} "${deleteTarget?.name}"?`}
        okText={t("delete")}
        cancelText={t("cancel")}
        onOk={() => { if (deleteTarget) deleteProject(deleteTarget.id); setDeleteTarget(null); }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
