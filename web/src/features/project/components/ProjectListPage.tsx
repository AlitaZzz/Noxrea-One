/**
 * 项目列表页 UI（挂载于 /project 路由壳）。
 * 展示当前用户的全部画布项目（新建卡片 + 项目网格），支持新建、打开、重命名、删除；
 * 顶部头像菜单提供账户设置入口与语言偏好切换、退出登录。
 */

"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import AppShell from "@/components/layout/AppShell";
import { CheckOutlined, ChevronDownIcon, ClockCircleOutlined, DeleteOutlined, EditOutlined, EllipsisOutlined, FolderOpenOutlined, PictureOutlined, PlusOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import SettingsModal from "@/features/auth/components/SettingsModal";
import { UserMenuPopover } from "@/features/auth/components/UserMenuPopover";
import { useAuthStore } from "@/features/auth/store";
import { useCurrentUser } from "@/features/auth/UserContext";
import { flushAndWait } from "@/features/canvas/stores/canvas-store";
import { useProjectStore } from "@/features/project/store";
import type { ProjectSummary } from "@/features/project/types";
import { classifyUploadError, uploadWithRetry } from "@/lib/utils/upload";

function projectThumbnailUrl(src: string): string {
  if (!src.includes("/api/files/")) return src;
  const hashIndex = src.indexOf("#");
  const hash = hashIndex >= 0 ? src.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? src.slice(0, hashIndex) : src;
  const queryIndex = withoutHash.indexOf("?");
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";
  const params = new URLSearchParams(query);
  params.set("w", "480");
  return `${pathname}?${params.toString()}${hash}`;
}

// 固定信息区高度，让空列表首帧与项目数据加载后的网格行保持同一尺寸。
const PROJECT_CARD_INFO_CLASS = "h-[100px] shrink-0 p-3";

export default function ProjectListPage() {
  const router = useRouter();
  const { notification } = useAppFeedback();
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
      notification.error({ title: info.message, placement: "bottomRight", duration: 6 });
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

  const handleCardKeyDown = (event: React.KeyboardEvent, onOpen: () => void) => {
    if ((event.target as HTMLElement).closest("button, input, a, [role='menuitem']")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen();
  };

  return (
    <AppShell>
      <div className="ui-select-none h-full overflow-y-auto p-6 text-foreground md:p-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-8 max-w-6xl mx-auto">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold m-0">{t("project.all")}</h1>
          <span className="text-sm text-muted-foreground">{projects.length}</span>
        </div>

        <UserMenuPopover
          open={avatarOpen}
          onOpenChange={setAvatarOpen}
          placement="bottomRight"
          items={[
            { key: "settings", label: t("auth.accountSettings") },
            {
              key: "lang",
              label: i18n.language === "zh" ? "简体中文" : "English",
              extra: <span className="text-xs font-semibold opacity-60">{i18n.language === "zh" ? "中" : "EN"}</span>,
            },
          ]}
          onItemClick={(key) => {
            if (key === "settings") {
              setSettingsOpen(true);
            } else if (key === "lang") {
              useAuthStore.getState().savePreference("language", i18n.language === "zh" ? "en" : "zh");
            }
          }}
          onLogout={() => useAuthStore.getState().logout().finally(() => router.push("/login"))}
          trigger={
            /* 用户信息 SSR 直出（根布局注入 cookie 缓存），水合后由 /me 校正 */
            <Button
              type="button"
              variant="ghost"
              aria-label={t("auth.accountSettings")}
              className="h-auto gap-2 rounded-lg bg-popover px-2 py-1 text-foreground hover:bg-muted"
            >
              <div className={`flex size-8 items-center justify-center overflow-hidden rounded-full text-xs font-bold ${user?.avatarUrl ? "bg-transparent" : "bg-primary text-primary-foreground"}`}>
                {user?.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  (user?.username || "U")[0].toUpperCase()
                )}
              </div>
              <span className="text-sm font-medium text-foreground">{user?.username || t("auth.defaultUser")}</span>
              <ChevronDownIcon className="size-3 text-muted-foreground" />
            </Button>
          }
        />
      </div>

      {/* Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 max-w-6xl mx-auto">
          {/* Create new project card — always first */}
          <Card
            className="group relative flex cursor-pointer flex-col gap-0 overflow-hidden border-dashed border-border bg-card p-0"
            role="button"
            tabIndex={0}
            aria-label={t("project.new")}
            onClick={handleCreate}
            onKeyDown={(event) => handleCardKeyDown(event, handleCreate)}
          >
            <div className="flex aspect-video items-center justify-center" aria-hidden="true" />
            <CardContent aria-hidden="true" className={PROJECT_CARD_INFO_CLASS} />
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center p-6">
              <div className="flex size-12 items-center justify-center rounded-full border border-dashed border-muted-foreground/50 bg-muted/30 transition-colors group-hover:border-primary group-hover:bg-primary/10">
                <PlusOutlined className="text-2xl text-muted-foreground transition-colors group-hover:text-primary" />
              </div>
              <span className="mt-3 text-sm font-medium text-foreground">{t("project.new")}</span>
            </div>
          </Card>

          {projects.map((p) => (
            <Card
              key={p.id}
              className="group relative flex h-full cursor-pointer gap-0 overflow-hidden border-border bg-card p-0"
              role="button"
              tabIndex={0}
              aria-label={p.name}
              onClick={() => handleOpen(p)}
              onKeyDown={(event) => handleCardKeyDown(event, () => handleOpen(p))}
            >
              {/* Preview area（服务端投影：自定义封面优先，否则画布首图） */}
              <div
                className="flex aspect-video items-center justify-center overflow-hidden bg-popover"
              >
                {p.thumbnail ? (
                  <img src={projectThumbnailUrl(p.thumbnail)} alt="" className="block h-full w-full object-cover transition-transform duration-200 ease-out group-hover:scale-[1.03]" loading="lazy" decoding="async" />
                ) : (
                  <FolderOpenOutlined className="text-3xl text-muted-foreground" />
                )}
              </div>

              {/* Info */}
              <CardContent className={PROJECT_CARD_INFO_CLASS}>
                <div className="flex h-9 min-w-0 items-center justify-between gap-2">
                  {editingId === p.id ? (
                    <Input
                      className="flex-1 min-w-0 text-sm font-medium"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onBlur={() => { if (editName.trim()) renameProject(p.id, editName.trim()); setEditingId(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <div className="flex h-full min-w-0 flex-1 items-center truncate text-sm font-medium">{p.name}</div>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={t("common.moreActions")}
                        onMouseDown={(e) => {
                          if (editingId === p.id) e.preventDefault();
                          e.stopPropagation();
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <EllipsisOutlined />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-auto min-w-36" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem disabled={coverUploadingId !== null} onSelect={() => handlePickCover(p.id)}>
                        <PictureOutlined />
                        {t("project.setCover")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          if (editingId === p.id) {
                            if (editName.trim()) renameProject(p.id, editName.trim());
                            setEditingId(null);
                          } else {
                            setEditingId(p.id);
                            setEditName(p.name);
                          }
                        }}
                      >
                        {editingId === p.id ? <CheckOutlined /> : <EditOutlined />}
                        {editingId === p.id ? t("common.save") : t("common.rename")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleteTarget(p)}>
                        <DeleteOutlined />
                        {t("common.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="mt-1.5 flex min-h-8 items-end justify-between gap-3">
                  <div className="min-w-0 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1 truncate">
                      <ClockCircleOutlined className="shrink-0 text-[10px]" />
                      <span className="truncate">{formatDate(p.updatedAt)}</span>
                    </div>
                    <div className="mt-0.5 truncate">
                      {p.nodeCount}{t("canvas.nodesCount")}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
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
        confirmVariant="destructive"
        cancelText={t("common.cancel")}
        onOk={() => { if (deleteTarget) deleteProject(deleteTarget.id); setDeleteTarget(null); }}
        onCancel={() => setDeleteTarget(null)}
      />
      </div>
    </AppShell>
  );
}
