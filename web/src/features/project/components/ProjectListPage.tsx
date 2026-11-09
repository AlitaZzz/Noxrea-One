/**
 * 项目列表页 UI（挂载于 /project 路由壳）。
 * 展示当前用户的全部画布项目（新建卡片 + 项目网格），支持新建、打开、重命名、删除；
 * 顶部头像菜单提供账户设置入口与语言偏好切换、退出登录。
 */

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ResolvedImage } from "@/components/media/ResolvedMedia";
import { CheckOutlined, ChevronDownIcon, ClockCircleOutlined, DeleteOutlined, EditOutlined, EllipsisOutlined, FolderOpenOutlined, PictureOutlined, PlusOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import DestructiveConfirmModal from "@/components/ui/DestructiveConfirmModal";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { uploadMany } from "@/entities/asset";
import type { ProjectSummary } from "@/entities/project";
import {
  activateProject,
  createProject,
  deleteProject,
  refreshProjects,
  renameProject,
  updateCover,
  useProjects,
} from "@/entities/project";
import { logout, savePreference, useCurrentUser } from "@/entities/user";
import type { AccountSettingsProps, UserMenuProps } from "@/types/user-menu";

// 固定信息区高度，让空列表首帧与项目数据加载后的网格行保持同一尺寸。
const PROJECT_CARD_INFO_CLASS = "h-[100px] shrink-0 p-3";

interface ProjectListPageProps {
  /** app 注入：等待画布未落盘的保存完成（项目列表不导入 canvas） */
  flushPendingCanvasSaves: () => Promise<void>;
  /** app 注入：用户菜单 UI（features/auth） */
  accountMenu: ComponentType<UserMenuProps>;
  /** app 注入：账号设置弹窗 UI（features/auth） */
  accountSettings: ComponentType<AccountSettingsProps>;
}

export default function ProjectListPage({
  flushPendingCanvasSaves,
  accountMenu: AccountMenu,
  accountSettings: AccountSettings,
}: ProjectListPageProps) {
  const router = useRouter();
  const { notification } = useAppFeedback();
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  // 改封面：选图目标卡片 + 上传中的卡片 ID（单 file input 复用）
  const coverInputRef = useRef<HTMLInputElement>(null);
  const coverTargetRef = useRef<string | null>(null);
  const [coverUploadingId, setCoverUploadingId] = useState<string | null>(null);
  const user = useCurrentUser();
  const { t, i18n } = useTranslation();
  const projects = useProjects();

  const pathname = usePathname();

  // 进入项目列表页时：先等待画布未落盘的保存完成，再拉取数据库。
  // 若不等待直接拉列表，GET 可能与画布保存竞态，拿到旧的 updatedAt 排序。
  useEffect(() => {
    if (pathname !== "/project") return;
    let cancelled = false;
    flushPendingCanvasSaves().finally(() => {
      if (!cancelled) refreshProjects();
    });
    return () => { cancelled = true; };
  }, [pathname, flushPendingCanvasSaves]);

  useEffect(() => {
    if (!editingId) return;
    const frame = requestAnimationFrame(() => {
      const input = editInputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      input.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [editingId]);

  // 鉴权由 (app)/layout.tsx 统一完成；项目列表由本页拉取（唯一消费方）。

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
      // 走 entity 公共上传通道：离线 / 不支持类型 / 体积超限在发请求前统一拦截
      const { outcomes } = await uploadMany([{ blob: file, filename: file.name }]);
      const outcome = outcomes[0];
      // 封面落库存 key；展示 URL 由渲染期派生
      if (outcome?.result) updateCover(targetId, outcome.result.key);
      else if (outcome?.error) notification.error({ title: outcome.error.message, placement: "bottomRight", duration: 6 });
    } finally {
      setCoverUploadingId(null);
    }
  };

  const handleCreate = async () => {
    // 命令成功后已写入 activeProjectId；项目身份仍以 URL 为准
    const project = await createProject();
    // 失败提示由 entity 统一负责；返回 null 时不导航
    if (!project) return;
    router.push(`/canvas/${project.id}`);
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <div className="ui-select-none h-full overflow-y-auto p-6 text-foreground md:p-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-8 max-w-6xl mx-auto">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold m-0">{t("project.all")}</h1>
          <span className="text-sm text-muted-foreground">{projects.length}</span>
        </div>

        <AccountMenu
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
              void savePreference("language", i18n.language === "zh" ? "en" : "zh");
            }
          }}
          onLogout={() => logout().finally(() => router.push("/login"))}
          trigger={
            /* 用户信息 SSR 直出（根布局注入 cookie 缓存），水合后由 /me 校正 */
            <Button
              type="button"
              variant="ghost"
              aria-label={t("auth.accountSettings")}
              className="h-auto gap-2 rounded-lg bg-popover px-2 py-1 text-foreground hover:bg-muted"
            >
              <div className="flex size-8 items-center justify-center overflow-hidden rounded-full text-xs font-bold">
                <ResolvedImage
                  value={user?.avatarKey}
                  alt=""
                  className="h-full w-full object-cover"
                  fallback={(
                    <span className="flex size-full items-center justify-center bg-primary text-primary-foreground">
                      {(user?.username || "U")[0].toUpperCase()}
                    </span>
                  )}
                />
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
            className="group relative flex flex-col gap-0 overflow-hidden border-dashed border-border bg-card p-0"
          >
            <Button
              type="button"
              variant="ghost"
              aria-label={t("project.new")}
              onClick={handleCreate}
              className="relative flex h-full w-full flex-col gap-0 rounded-none p-0"
            >
              <span className="block aspect-video w-full shrink-0" aria-hidden="true" />
              <span aria-hidden="true" className={`block w-full ${PROJECT_CARD_INFO_CLASS}`} />
              <span className="absolute inset-0 z-10 flex flex-col items-center justify-center p-6">
                <span className="flex size-12 items-center justify-center rounded-full border border-dashed border-muted-foreground/50 bg-muted/30 transition-colors group-hover:border-primary group-hover:bg-primary/10">
                  <PlusOutlined className="text-2xl text-muted-foreground transition-colors group-hover:text-primary" />
                </span>
                <span className="mt-3 text-sm font-medium text-foreground">{t("project.new")}</span>
              </span>
            </Button>
          </Card>

          {projects.map((p) => (
            <Card
              key={p.id}
              className="group relative flex h-full flex-col gap-0 overflow-hidden border-border bg-card p-0"
            >
              {/* Preview area（服务端投影：自定义封面优先，否则画布首图）；跳转由整卡 stretched-link 承担 */}
              <div className="flex aspect-video h-auto w-full shrink-0 items-center justify-center overflow-hidden rounded-none bg-popover p-0 text-foreground">
                {p.thumbnail ? (
                  <ResolvedImage
                    value={p.thumbnail}
                    width={480}
                    alt=""
                    className="block h-full w-full object-cover transition-transform duration-200 ease-out group-hover:scale-[1.03]"
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <FolderOpenOutlined className="text-3xl text-muted-foreground" />
                )}
              </div>

              {/* Info */}
              <CardContent className={PROJECT_CARD_INFO_CLASS}>
                <div className="flex h-9 min-w-0 items-center justify-between gap-2">
                  {editingId === p.id ? (
                    <Input
                      ref={editInputRef}
                      className="relative z-10 flex-1 min-w-0 text-sm font-medium"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onBlur={() => { if (editName.trim()) renameProject(p.id, editName.trim()); setEditingId(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={t("common.moreActions")}
                        className="relative z-10"
                      >
                        <EllipsisOutlined />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-auto min-w-36">
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

              {/* 整卡跳转（stretched-link）：铺满卡片承担导航，菜单/重命名等交互控件以 relative z-10 浮于其上 */}
              <Link
                href={`/canvas/${p.id}`}
                onClick={() => activateProject(p.id)}
                aria-label={p.name}
                className="absolute inset-0 z-0 cursor-pointer rounded-[inherit] outline-none focus-visible:inset-ring-3 focus-visible:inset-ring-ring/50"
              />
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

      <AccountSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <DestructiveConfirmModal
        open={!!deleteTarget}
        title={t("project.delete")}
        description={t("project.deleteConfirm", { name: deleteTarget?.name ?? "" })}
        confirmText={t("common.delete")}
        cancelText={t("common.cancel")}
        onConfirm={async () => {
          if (!deleteTarget) return false;
          // 画布保存可能仍在途中：先落盘再删除，避免保存请求在项目删除后到达
          await flushPendingCanvasSaves();
          return deleteProject(deleteTarget.id);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
