/**
 * 项目列表页 UI（挂载于 /project 路由壳）。
 * 展示当前用户的全部画布项目（新建卡片 + 项目网格），支持新建、打开、重命名、删除；
 * 顶部头像菜单提供账户设置入口与语言偏好切换、退出登录。
 */
"use client";

import { CheckOutlined, ClockCircleOutlined,DeleteOutlined, EditOutlined, FolderOpenOutlined, PictureOutlined, PlusOutlined } from "@ant-design/icons";
import { Popover } from "antd";
import { usePathname,useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import AppShell from "@/components/layout/AppShell";
import AppButton from "@/components/ui/AppButton";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { ChevronDownIcon } from "@/components/ui/icons/common/ChevronDownIcon";
import { MenuDivider,MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import SettingsModal from "@/features/auth/components/SettingsModal";
import { useAuthStore } from "@/features/auth/store";
import { useCurrentUser } from "@/features/auth/UserContext";
import { flushAndWait } from "@/features/canvas/stores/canvas-store";
import { useProjectStore } from "@/features/project/store";
import type { ProjectSummary } from "@/features/project/types";
import { showGlobalNotification } from "@/lib/global-notification";
import { classifyUploadError, uploadWithRetry } from "@/lib/utils/upload";

export default function ProjectListPage() {
  const router = useRouter();
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  // 改封面：选图目标卡片 + 上传中的卡片 ID（单 file input 复用）
  const coverInputRef = useRef<HTMLInputElement>(null);
  const coverTargetRef = useRef<string | null>(null);
  const [coverUploadingId, setCoverUploadingId] = useState<string | null>(null);
  const renameProject = useProjectStore((s) => s.renameProject);
  const updateCover = useProjectStore((s) => s.updateCover);
  const user = useCurrentUser();
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

  // 鉴权由 (app)/layout.tsx 统一完成；项目列表由本页拉取（唯一消费方）。

  const handleOpen = (p: ProjectSummary) => {
    setActiveProject(p.id);
    router.push(`/canvas/${p.id}`);
  };

  // 改封面入口：点击记录目标卡片并弹浏览器文件选择框
  const handlePickCover = (id: string) => {
    coverTargetRef.current = id;
    coverInputRef.current?.click();
  };

  // 选图后：走公共上传通道，成功即提交封面（store 乐观更新 + 失败回滚提示）
  const handleCoverChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetId = coverTargetRef.current;
    // 允许同一文件重复选择：读取后立即清空 input 值
    e.target.value = "";
    coverTargetRef.current = null;
    if (!file || !targetId) return;

    setCoverUploadingId(targetId);
    try {
      const result = await uploadWithRetry(file);
      useProjectStore.getState().updateCover(targetId, result.url);
    } catch (err) {
      const info = classifyUploadError(err);
      showGlobalNotification().error({ title: info.message, placement: "bottomRight", duration: 6 });
    } finally {
      setCoverUploadingId(null);
    }
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
      <div className="ui-select-none h-full overflow-y-auto p-6 md:p-10" style={{ color: "var(--canvas-text)" }}>
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
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold overflow-hidden" style={{ background: user?.avatarUrl ? "transparent" : "var(--canvas-accent)", color: "var(--canvas-app-bg)" }}>
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
                onClick={() => { const newLang = i18n.language === "zh" ? "en" : "zh"; useAuthStore.getState().savePreference("language", newLang); setAvatarOpen(false); }}>
<span>{i18n.language === "zh" ? "简体中文" : "English"}</span><span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, opacity: 0.6 }}>{i18n.language === "zh" ? "中" : "EN"}</span>
              </button>
              <div style={{ height: 1, background: "var(--canvas-border)", margin: "2px 6px" }} />
              <button className="avatar-menu-item text-left px-3 py-1.5 text-sm rounded transition-colors"
                style={{ color: "var(--canvas-text-dim)", border: "none", cursor: "pointer", background: "transparent" }}
                onClick={() => { setAvatarOpen(false); useAuthStore.getState().logout().finally(() => router.push("/login")); }}>
                {t("auth.logout")}
              </button>
            </div>
          }
          trigger="click"
          placement="bottomRight"
          open={avatarOpen}
          onOpenChange={setAvatarOpen}
        >
          {/* 用户信息 SSR 直出（根布局注入 cookie 缓存），水合后由 /me 校正 */}
          <div className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity rounded-lg px-2 py-1" style={{ background: "var(--canvas-bg-elevated)" }}>
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold overflow-hidden" style={{ background: user?.avatarUrl ? "transparent" : "var(--canvas-accent)", color: "var(--canvas-app-bg)" }}>
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
              {/* Preview area（服务端投影：自定义封面优先，否则画布首图） */}
              <div
                className="aspect-video rounded-t-xl flex items-center justify-center overflow-hidden"
                style={{ background: "var(--canvas-bg-elevated)" }}
              >
                {p.thumbnail ? (
                  <img src={p.thumbnail} alt="" className="w-full h-full object-cover" />
                ) : (
                  <FolderOpenOutlined className="text-3xl" style={{ color: "var(--canvas-text-muted)" }} />
                )}
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
                    <AppButton
                      size="sm"
                      iconOnly
                      variant="ghost"
                      aria-label={t("project.setCover")}
                      loading={coverUploadingId === p.id}
                      disabled={coverUploadingId !== null}
                      onClick={() => handlePickCover(p.id)}
                    >
                      <PictureOutlined />
                    </AppButton>
                    <AppButton
                      size="sm"
                      iconOnly
                      variant="ghost"
                      aria-label={editingId === p.id ? t("common.save") : t("common.edit")}
                      // 编辑态点击不让 input 先失焦（blur 保存 + click 重开会产生闪跳），由 click 统一切换
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        if (editingId === p.id) {
                          if (editName.trim()) renameProject(p.id, editName.trim());
                          setEditingId(null);
                        } else {
                          setEditingId(p.id);
                          setEditName(p.name);
                        }
                      }}
                    >
                      {/* 确认对勾用青柠：与检查器内联保存等肯定语义一致（globals.css 品牌色规则） */}
                      {editingId === p.id ? <CheckOutlined style={{ color: "var(--canvas-accent)" }} /> : <EditOutlined />}
                    </AppButton>
                    <AppButton
                      size="sm"
                      iconOnly
                      variant="ghost"
                      aria-label={t("common.delete")}
                      onClick={() => setDeleteTarget(p)}
                    >
                      <DeleteOutlined />
                    </AppButton>
                  </div>
                </div>
                <div className="flex items-center gap-1 mt-1.5 text-xs" style={{ color: "var(--canvas-text-muted)" }}>
                  <ClockCircleOutlined className="text-[10px]" />
                  {formatDate(p.updatedAt)}
                </div>
                <div className="text-xs mt-0.5" style={{ color: "var(--canvas-text-muted)" }}>
                  {p.nodeCount}{t("canvas.nodesCount")}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* 改封面：隐藏 file input，卡片按钮触发选择 */}
        <input
          ref={coverInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleCoverChange}
        />

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <ConfirmModal
        open={!!deleteTarget}
        title={t("project.delete")}
        content={t("project.deleteConfirm", { name: deleteTarget?.name ?? "" })}
        okText={t("common.delete")}
        cancelText={t("common.cancel")}
        onOk={() => { if (deleteTarget) deleteProject(deleteTarget.id); setDeleteTarget(null); }}
        onCancel={() => setDeleteTarget(null)}
      />
      </div>
    </AppShell>
  );
}
