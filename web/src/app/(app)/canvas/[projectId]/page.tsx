/**
 * 画布页面（/canvas/[projectId]）。
 * 页面是唯一的组合根：持有画布会话、加载门、页面壳浮层（资产库、设置、
 * 快捷键、Director、退出 / 删除确认）与项目操作；画布本身通过 `CanvasRoot`
 * 的 ports / slots 契约装配，不反向依赖其它 feature。
 *
 * 以 URL 上的项目 ID 作为项目身份的唯一真相源。画布初始内容由 SSE 原子握手
 * 下发（轮换租约 + 快照读，见 use-canvas-session）：会话 ready 才放行渲染，
 * 页面不再单独发 GET 拉取项目。ID 缺失、或项目不存在 / 会话无法建立时回退到 /project。
 */
"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import AppShell from "@/components/layout/AppShell";
import CanvasLoader from "@/components/layout/CanvasLoader";
import ConfirmModal from "@/components/ui/ConfirmModal";
import DestructiveConfirmModal from "@/components/ui/DestructiveConfirmModal";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getAssetsInitialized, initialize as initializeAssets } from "@/entities/asset";
import { activateProject, createProject, deleteProject, useActiveProjectSummary } from "@/entities/project";
import { logout } from "@/entities/user";
import { AssetBrowserPanel, AssetsDialog } from "@/features/assets";
import { UserMenuPopover } from "@/features/auth";
import {
  type CanvasPorts,
  CanvasRoot,
  type CanvasSlots,
  flushCanvasSave,
  preloadCanvasPromptTemplates,
  useCanvasSession,
  useDirectorBridge,
  useSessionExpired,
} from "@/features/canvas";
import { ApiSettingsDrawer } from "@/features/settings";
import { useModelStore } from "@/lib/model-store";
import { modKey } from "@/lib/platform";
import type { UserMenuItem } from "@/types/user-menu";

const DirectorOverlay = dynamic(
  () => import("@/features/director").then((mod) => mod.DirectorOverlay),
  { ssr: false },
);

export default function CanvasPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const projectName = useActiveProjectSummary()?.name ?? "";

  // 编辑权会话：SSE 原子握手成功（租约签发 + 初始内容恢复完成）即 ready。
  // 页面在 ready 前只渲染加载门——未取得编辑权与内容前不暴露画布，
  // 也不存在「先驱逐他人再慢慢加载」的窗口。
  const session = useCanvasSession(projectId);
  // 会话过期（画布编辑权被其他页面实例取得）：唯一出口是刷新页面
  const sessionExpired = useSessionExpired();

  // 持久化设置（模型库 / 素材库 / 预设目录）的加载态：与会话并行就绪，
  // 全部就绪才放行画布——面板与 chip 挂载时数据必然齐，不存在空态竞态；
  // 失败停在 loading 显示重试（网络恢复后可继续），不带着空数据进画布
  const [settingsStatus, setSettingsStatus] = useState<"loading" | "ready" | "failed">("loading");

  // 页面壳开关：全部由 page 持有，折算为 inputBlocked 后交给画布阻断输入。
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsVisible, setShortcutsVisible] = useState(false);
  const [directorNodeId, setDirectorNodeId] = useState<string | null>(null);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const openAssets = useCallback(() => setAssetsOpen(true), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openShortcuts = useCallback(() => setShortcutsVisible(true), []);
  const openDirector = useCallback((nodeId: string) => setDirectorNodeId(nodeId), []);
  const closeDirector = useCallback(() => setDirectorNodeId(null), []);
  const openLogoutConfirm = useCallback(() => setLogoutConfirmOpen(true), []);
  const closeLogoutConfirm = useCallback(() => setLogoutConfirmOpen(false), []);
  const closeDeleteConfirm = useCallback(() => setDeleteConfirmOpen(false), []);

  const ports = useMemo<CanvasPorts>(
    () => ({ onOpenAssets: openAssets, onOpenSettings: openSettings, onOpenShortcuts: openShortcuts, onOpenDirector: openDirector }),
    [openAssets, openDirector, openSettings, openShortcuts],
  );

  // URL 是项目身份的真相源：同步进 store 作为激活会话标记
  useEffect(() => {
    if (!projectId) {
      router.replace("/project");
      return;
    }
    activateProject(projectId);
  }, [projectId, router]);

  // 会话终态：项目不存在（404）/ 会话无法建立 → 回项目列表
  useEffect(() => {
    if (session === "missing" || session === "error") {
      router.replace("/project");
    }
  }, [router, session]);

  // 纯拉取（不碰 React state，结果由调用方决定去向）：模型库 / 素材库 / 预设目录并行拉齐。
  // 两条 initialize 内部吞异常，以 initialized 表达成败（失败保持 false 以允许重试）；
  // 预设目录的可用性判据由 preloadCanvasPromptTemplates 统一表达。
  const loadSettings = useCallback(async (): Promise<"ready" | "failed"> => {
    const ready = await Promise.all([
      useModelStore.getState().initialize().then(() => useModelStore.getState().initialized),
      initializeAssets().then(() => getAssetsInitialized()),
      preloadCanvasPromptTemplates(queryClient),
    ]);
    return ready.every(Boolean) ? "ready" : "failed";
  }, [queryClient]);

  // 重试：事件回调内同步置 loading，结果经 .then 回写
  const retrySettings = useCallback(() => {
    setSettingsStatus("loading");
    loadSettings().then((status) => setSettingsStatus(status));
  }, [loadSettings]);

  useEffect(() => {
    let cancelled = false;
    loadSettings().then((status) => {
      if (!cancelled) setSettingsStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, [loadSettings]);

  // 鉴权初始化已由 (app)/layout.tsx 统一完成；项目内容不在页面拉取：
  // SSE 握手首帧即权威快照（use-canvas-session 内完成采纳与恢复）。

  // ── 项目菜单：条目随语言变化，动作归页面 ──
  const projectMenuItems = useMemo<UserMenuItem[]>(
    () => [
      { key: "home", label: t("project.home") },
      { type: "divider" },
      { key: "new", label: t("project.new") },
      { key: "delete", label: t("project.delete") },
    ],
    [t],
  );

  const handleUserMenuSelect = useCallback((key: string) => {
    if (key === "home") {
      void (async () => {
        await flushCanvasSave();
        router.push("/project");
      })();
    } else if (key === "new") {
      void (async () => {
        await flushCanvasSave();
        const created = await createProject();
        // 失败提示由 entity 统一负责；返回 null 时不导航
        if (!created) return;
        // 画布身份以 URL 为准：router.replace 触发页面层重新握手与恢复
        router.replace(`/canvas/${created.id}`);
      })();
    } else if (key === "delete") {
      setDeleteConfirmOpen(true);
    }
  }, [router]);

  const handleDeleteProject = useCallback(async () => {
    await flushCanvasSave();
    const deleted = await deleteProject(projectId);
    if (deleted) router.push("/project");
    return deleted;
  }, [projectId, router]);

  const handleLogout = useCallback(() => {
    setLogoutConfirmOpen(false);
    // 等 cookie 清除完成再导航，否则 proxy.ts 仍凭 cookie 放行并弹回应用
    void logout().finally(() => router.push("/"));
  }, [router]);

  // ── slots：画布只提供分发点，内容与状态全部由页面决定 ──
  // assetsDialog 是唯一随开合变化的插槽：渲染函数捕获 assetsOpen，
  // 其余插槽保持稳定引用，页面壳开关变化不波及画布节点树。
  const userMenuSlot = useCallback<CanvasSlots["userMenu"]>(
    (api) => (
      <UserMenuPopover
        placement="bottomLeft"
        items={projectMenuItems}
        onItemClick={handleUserMenuSelect}
        onLogout={openLogoutConfirm}
        trigger={api.trigger}
        open={api.open}
        onOpenChange={api.onOpenChange}
      />
    ),
    [handleUserMenuSelect, openLogoutConfirm, projectMenuItems],
  );

  const assetBrowserSlot = useCallback<CanvasSlots["assetBrowser"]>(
    (api) => <AssetBrowserPanel onInsertAsset={api.onInsertAsset} />,
    [],
  );

  const assetsDialogSlot = useCallback<CanvasSlots["assetsDialog"]>(
    (api) => (
      <AssetsDialog
        open={assetsOpen}
        onOpenChange={setAssetsOpen}
        onInsertAsset={api.onInsertAsset}
        onInsertAssets={api.onInsertAssets}
      />
    ),
    [assetsOpen],
  );

  const slots = useMemo<CanvasSlots>(
    () => ({ userMenu: userMenuSlot, assetBrowser: assetBrowserSlot, assetsDialog: assetsDialogSlot }),
    [assetBrowserSlot, assetsDialogSlot, userMenuSlot],
  );

  // 页面壳任一浮层打开即阻断画布输入；画布内部编辑面板由 canvas 自行合并。
  const inputBlocked = assetsOpen || settingsOpen || shortcutsVisible || directorNodeId !== null || logoutConfirmOpen || deleteConfirmOpen;

  // Director 桥：节点身份由页面持有，快照读写与出图落位由 canvas 负责。
  const director = useDirectorBridge(directorNodeId);

  // 加载门：会话 ready（租约 + 初始内容就绪）且持久化设置齐备才放行画布。
  // 画布主体存入 stage：过期弹窗渲染在 return 顶层（加载门之外）——加载期间
  // 编辑权被其他实例取得（SPA 返回遇上 superseded 只收 evict）时，弹窗必须
  // 已可见，而不是被加载门挡住导致永久悬置
  const stage = session !== "ready" || settingsStatus !== "ready" ? (
    <CanvasLoader
      failed={settingsStatus === "failed"}
      onRetry={settingsStatus === "failed" ? retrySettings : undefined}
    />
  ) : (
    <ReactFlowProvider>
      <AppShell>
        <CanvasRoot projectId={projectId} ports={ports} slots={slots} inputBlocked={inputBlocked} />
      </AppShell>

      {/* 快捷键说明弹窗 */}
      <Dialog open={shortcutsVisible} onOpenChange={(nextOpen) => { if (!nextOpen) setShortcutsVisible(false); }}>
        <DialogContent className="sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle>{t("shortcuts.title")}</DialogTitle>
          </DialogHeader>
          {(() => {
            const kb = (v: string) => <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{v}</kbd>;
            const row = (key: string, desc: string) => <div>{kb(key)} {desc}</div>;
            return (
              <div className="space-y-3 text-foreground">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("shortcuts.zoom")}</div>
                <div className="grid grid-cols-2 gap-1.5 text-sm">
                  {row("Scroll", t("shortcuts.desc.scroll"))}
                  {row(t("shortcuts.key.spaceDrag"), t("shortcuts.desc.pan"))}
                  {row(t("shortcuts.key.middleDrag"), t("shortcuts.desc.pan"))}
                  {row(modKey("="), t("shortcuts.desc.zoomin"))}
                  {row(modKey("-"), t("shortcuts.desc.zoomout"))}
                  {row(modKey("0"), t("shortcuts.desc.reset"))}
                  {row(modKey("M"), t("shortcuts.desc.minimap"))}
                </div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("shortcuts.edit")}</div>
                <div className="grid grid-cols-2 gap-1.5 text-sm">
                  {row(t("shortcuts.key.drag"), t("shortcuts.desc.selectRegion"))}
                  {row(modKey("A"), t("shortcuts.desc.selectall"))}
                  {row(t("shortcuts.key.shiftClick"), t("shortcuts.desc.multiselect"))}
                  {row(modKey("C"), t("shortcuts.desc.copy"))}
                  {row(modKey("V"), t("shortcuts.desc.paste"))}
                  {row("Delete", t("shortcuts.desc.delete"))}
                  {row("Escape", t("shortcuts.desc.esc"))}
                </div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("shortcuts.group")}</div>
                <div className="grid grid-cols-2 gap-1.5 text-sm">
                  {row(modKey("G"), t("shortcuts.desc.group"))}
                  {row(modKey("Shift+G"), t("shortcuts.desc.ungroup"))}
                  {row(modKey("Z"), t("shortcuts.desc.undo"))}
                  {row(modKey("Shift+Z"), t("shortcuts.desc.redo"))}
                </div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("shortcuts.other")}</div>
                <div className="space-y-1 text-xs text-muted-foreground">
                  <div>? — {t("shortcuts.desc.help")}</div>
                  <div>{t("drop.upload")}</div>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Director 全屏编辑器：快照读写与出图经 canvas 桥接 */}
      {directorNodeId !== null && (
        <DirectorOverlay
          initialState={director.initialState}
          onSaveState={director.onSaveState}
          onCreateImageNode={director.onCreateImageNode}
          onClose={closeDirector}
        />
      )}

      <ApiSettingsDrawer open={settingsOpen} onClose={closeSettings} />

      <DestructiveConfirmModal
        open={deleteConfirmOpen}
        title={t("project.delete")}
        description={t("project.deleteConfirm", { name: projectName })}
        confirmText={t("common.delete")}
        cancelText={t("common.cancel")}
        onConfirm={handleDeleteProject}
        onCancel={closeDeleteConfirm}
      />

      <ConfirmModal
        open={logoutConfirmOpen}
        title={t("auth.logout")}
        content={t("auth.logoutConfirm")}
        okText={t("auth.logout")}
        cancelText={t("common.cancel")}
        onOk={handleLogout}
        onCancel={closeLogoutConfirm}
      />
    </ReactFlowProvider>
  );

  return (
    <>
      {stage}

      {/* 会话过期：渲染在加载门外（stage 之上），加载期间被驱逐也可见。
          不可关闭，唯一动作是刷新；刷新即新页面实例，重新取得编辑权 */}
      <ConfirmModal
        open={sessionExpired}
        title={t("conflict.title")}
        content={t("conflict.content")}
        okText={t("conflict.reload")}
        hideCancel
        onOk={() => window.location.reload()}
        onCancel={() => window.location.reload()}
      />
    </>
  );
}
