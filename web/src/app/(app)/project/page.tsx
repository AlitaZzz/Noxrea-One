/**
 * 项目列表页（/project）。
 * 展示当前用户的全部画布项目（新建卡片 + 项目网格），支持新建、打开、重命名、删除；
 * 顶部头像菜单提供账户设置入口与语言 / 主题偏好切换、退出登录。
 */
"use client";

import { ClockCircleOutlined,DeleteOutlined, EditOutlined, FolderOpenOutlined, PlusOutlined } from "@ant-design/icons";
import { Popover } from "antd";
import { usePathname,useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import AppShell from "@/components/layout/AppShell";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { ChevronDownIcon } from "@/components/ui/icons/common/ChevronDownIcon";
import { ThemeDarkIcon } from "@/components/ui/icons/theme/ThemeDarkIcon";
import { ThemeLightIcon } from "@/components/ui/icons/theme/ThemeLightIcon";
import { MenuDivider,MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import SettingsModal from "@/features/auth/components/SettingsModal";
import { useAuthStore } from "@/features/auth/store";
import { flushAndWait, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useProjectStore } from "@/features/project/store";
import type { CanvasProject } from "@/features/project/types";

export default function ProjectPage() {
  const router = useRouter();
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CanvasProject | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const renameProject = useProjectStore((s) => s.renameProject);
  const user = useAuthStore((s) => s.user);
  const theme = useCanvasStore((s) => s.theme);
  const toggleTheme = useCanvasStore((s) => s.toggleTheme);
  const { t, i18n } = useTranslation();
  const projects = useProjectStore((s) => s.projects);
  const createProject = useProjectStore((s) => s.createProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const refreshProjects = useProjectStore((s) => s.refreshProjects);

  const pathname = usePathname();

  // 进入项目列表页时：先等待画布未落盘的保存完成，再拉取数据库。
  // 浏览器回退按钮导航时，/canvas 卸载会触发兜底保存（异步 PUT），
  // 若不等待直接拉列表，GET 会与保存 PUT 竞态，拿到旧的 updatedAt 排序。
  useEffect(() => {
    if (pathname !== "/project") return;
    let cancelled = false;
    flushAndWait().finally(() => {
      if (!cancelled) refreshProjects();
    });
    return () => { cancelled = true; };
  }, [pathname, refreshProjects]);

  // 鉴权与项目初始化已由 (app)/layout.tsx 统一完成。

  const handleOpen = (p: CanvasProject) => {
    setActiveProject(p.id);
    router.push(`/canvas/${p.id}`);
  };


  const handleCreate = async () => {
    const p = await createProject();
    setActiveProject(p.id);
    router.push(`/canvas/${p.id}`);
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <AppShell>
      <div className="h-full overflow-y-auto p-6 md:p-10" style={{ color: "var(--canvas-text)" }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-8 max-w-6xl mx-auto">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold m-0">{t("project.all")}</h1>
          <span className="text-sm" style={{ color: "var(--canvas-text-dim)" }}>{projects.length}</span>
        </div>

        <Popover
          content={
            <div className="flex flex-col p-2 gap-0.5" style={{ margin: -12, background: "var(--canvas-bg)", borderRadius: 8, minWidth: 180 }}>
              <style>{`.avatar-menu-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
              <div className="flex items-center gap-2 px-1 py-1.5">
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold overflow-hidden" style={{ background: user?.avatarUrl ? "transparent" : "#1677ff", color: "#fff" }}>
                  {user?.avatarUrl ? <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" /> : (user?.username || "U")[0].toUpperCase()}
                </div>
                <span className="text-sm font-medium" style={{ color: "var(--canvas-text)" }}>{user?.username}</span>
              </div>
              <div style={{ height: 1, background: "var(--canvas-border)", margin: "2px 6px" }} />
              <button className="avatar-menu-item text-left px-3 py-1.5 text-sm rounded transition-colors"
                style={{ color: "var(--canvas-text)", border: "none", cursor: "pointer", background: "transparent" }}
                onClick={() => { setAvatarOpen(false); setSettingsOpen(true); }}>
                {t("auth.accountSettings")}
              </button>
              <div style={{ height: 1, background: "var(--canvas-border)", margin: "2px 6px" }} />
              <button className="avatar-menu-item text-left px-3 py-1.5 text-sm rounded transition-colors flex items-center gap-2"
                style={{ color: "var(--canvas-text)", border: "none", cursor: "pointer", background: "transparent", width: "100%" }}
                onClick={() => { const newLang = i18n.language === "zh" ? "en" : "zh"; i18n.changeLanguage(newLang); useAuthStore.getState().savePreference("language", newLang); setAvatarOpen(false); }}>
<span>{i18n.language === "zh" ? "简体中文" : "English"}</span><span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, opacity: 0.6 }}>{i18n.language === "zh" ? "中" : "EN"}</span>
              </button>
              <button className="avatar-menu-item text-left px-3 py-1.5 text-sm rounded transition-colors flex items-center gap-2"
                style={{ color: "var(--canvas-text)", border: "none", cursor: "pointer", background: "transparent", width: "100%" }}
                onClick={() => { const next = theme === "dark" ? "light" : "dark"; toggleTheme(); useAuthStore.getState().savePreference("theme", next); setAvatarOpen(false); }}>
{theme === "dark" ? (
                  <><span>{t("theme.dark")}</span><ThemeDarkIcon style={{ flexShrink: 0, marginLeft: "auto" }} /></>
                ) : (
                  <><span>{t("theme.light")}</span><ThemeLightIcon style={{ flexShrink: 0, marginLeft: "auto" }} /></>
                )}
              </button>
              <div style={{ height: 1, background: "var(--canvas-border)", margin: "2px 6px" }} />
              <button className="avatar-menu-item text-left px-3 py-1.5 text-sm rounded transition-colors"
                style={{ color: "var(--canvas-text-dim)", border: "none", cursor: "pointer", background: "transparent" }}
                onClick={() => { useAuthStore.getState().logout(); router.push("/login"); }}>
                {t("auth.logout")}
              </button>
            </div>
          }
          trigger="click"
          placement="bottomRight"
          open={avatarOpen}
          onOpenChange={setAvatarOpen}
        >
          <div className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity rounded-lg px-2 py-1" style={{ background: "var(--canvas-bg-elevated)" }}>
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold overflow-hidden" style={{ background: user?.avatarUrl ? "transparent" : "#1677ff", color: "#fff" }}>
              {user?.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                (user?.username || "U")[0].toUpperCase()
              )}
            </div>
            <span className="text-sm font-medium" style={{ color: "var(--canvas-text)" }}>{user?.username || "User"}</span>
            <ChevronDownIcon style={{ color: "var(--canvas-text-dim)", width: 10, height: 10 }} />
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
            <span className="text-sm" style={{ color: "var(--canvas-text-dim)" }}>{t("project.new")}</span>
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
                  {p.nodes?.length || 0}{t("canvas.nodesCount")}
                </div>
              </div>
            </div>
          ))}
        </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <ConfirmModal
        open={!!deleteTarget}
        title={t("project.delete")}
        content={`${t("project.deleteConfirm")} "${deleteTarget?.name}"?`}
        okText={t("common.delete")}
        cancelText={t("common.cancel")}
        onOk={() => { if (deleteTarget) deleteProject(deleteTarget.id); setDeleteTarget(null); }}
        onCancel={() => setDeleteTarget(null)}
      />
      </div>
    </AppShell>
  );
}
