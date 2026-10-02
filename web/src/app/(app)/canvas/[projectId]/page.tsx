/**
 * 画布页面（/canvas/[projectId]）。
 * 以 URL 上的项目 ID 作为项目身份的唯一真相源。画布初始内容由 SSE 原子握手
 * 下发（轮换租约 + 快照读，见 use-canvas-session）：会话 ready 才放行渲染，
 * 页面不再单独发 GET 拉取项目。装配 ReactFlowProvider、AppShell 与画布主体，
 * 并挂载两个页面级浮层：快捷键说明弹窗、Director 全屏编辑器。
 * ID 缺失、或项目不存在 / 会话无法建立时回退到 /project。
 */
"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import dynamic from "next/dynamic";
import { use, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import AppShell from "@/components/layout/AppShell";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAssetsStore } from "@/features/assets/store";
import { useCanvasKeyboard } from "@/features/canvas/hooks/use-canvas-keyboard";
import InfiniteCanvas from "@/features/canvas/InfiniteCanvas";
import CanvasLoader from "@/features/canvas/shared/CanvasLoader";
import {
  PROMPT_TEMPLATES_QUERY_KEY,
  promptTemplatesQueryOptions,
} from "@/features/canvas/shared/prompt-presets";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useSessionExpiredStore } from "@/features/project/session-expired-store";
import { useProjectStore } from "@/features/project/store";
import { useCanvasSession } from "@/features/project/use-canvas-session";
import { useModelStore } from "@/lib/model-store";
import { modKey } from "@/lib/platform";

const DirectorOverlay = dynamic(
  () => import("@/features/director/components/DirectorOverlay"),
  { ssr: false }
);

function CanvasWithKeyboard() {
  useCanvasKeyboard();
  return <InfiniteCanvas />;
}

export default function CanvasPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const { t } = useTranslation();
  const shortcutsVisible = useCanvasStore((s) => s.shortcutsVisible);
  const setShortcutsVisible = useCanvasStore((s) => s.setShortcutsVisible);
  const directorOverlayOpen = useCanvasStore((s) => s.directorOverlayOpen);
  const setDirectorOverlayOpen = useCanvasStore((s) => s.setDirectorOverlayOpen);
  const setModalOpen = useCanvasStore((s) => s.setModalOpen);
  // 编辑权会话：SSE 原子握手成功（租约签发 + 初始内容恢复完成）即 ready。
  // 页面在 ready 前只渲染加载门——未取得编辑权与内容前不暴露画布，
  // 也不存在「先驱逐他人再慢慢加载」的窗口。
  const session = useCanvasSession(projectId);
  // 持久化设置（模型库 / 素材库 / 预设目录）的加载态：与会话并行就绪，
  // 全部就绪才放行画布——面板与 chip 挂载时数据必然齐，不存在空态竞态；
  // 失败停在 loading 显示重试（网络恢复后可继续），不带着空数据进画布
  const [settingsStatus, setSettingsStatus] = useState<"loading" | "ready" | "failed">("loading");
  // 会话过期（画布编辑权被其他页面实例取得）：唯一出口是刷新页面
  const sessionExpired = useSessionExpiredStore((s) => s.expired);

  // URL 是项目身份的真相源：同步进 store 作为激活会话标记
  useEffect(() => {
    if (!projectId) {
      window.location.href = "/project";
      return;
    }
    useProjectStore.getState().setActiveProject(projectId);
  }, [projectId]);

  // 会话终态：项目不存在（404）/ 会话无法建立 → 回项目列表
  useEffect(() => {
    if (session === "missing" || session === "error") {
      window.location.href = "/project";
    }
  }, [session]);

  const queryClient = useQueryClient();
  // 纯拉取（不碰 React state，结果由调用方决定去向）：模型库 / 素材库 / 预设目录并行拉齐。
  // 两个 store 的 initialize 内部吞异常，以 initialized 表达成败（失败保持 false 以允许重试）。
  // 预设目录走 fetchQuery（共用 hook 的 query 选项：同一 key + gcTime: Infinity 常驻）：
  // staleTime 内命中缓存，过期则刷新；门页判据是「数据在不在」而非「这次请求成没成」——
  // 刷新失败但缓存仍有数据（短暂断网）时照常放行，后续面板内 react-query 的后台重试会继续追新；
  // 无数据且拉取失败才折算 failed。
  const loadSettings = useCallback(async (): Promise<"ready" | "failed"> => {
    const catalogReady = queryClient
      .fetchQuery(promptTemplatesQueryOptions())
      .then(
        () => true,
        () => queryClient.getQueryData(PROMPT_TEMPLATES_QUERY_KEY) !== undefined,
      );
    const ready = await Promise.all([
      useModelStore.getState().initialize().then(() => useModelStore.getState().initialized),
      useAssetsStore.getState().initialize().then(() => useAssetsStore.getState().initialized),
      catalogReady,
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

  // 鉴权初始化已由 (app)/layout.tsx 统一完成；项目列表不在画布页拉取（唯一消费方是 /project 门页）。
  // 项目内容不在页面拉取：SSE 握手首帧即权威快照（use-canvas-session 内完成采纳与恢复）。

  // Sync modalOpen when director overlay is open (blocks canvas shortcuts)
  useEffect(() => {
    if (directorOverlayOpen) {
      setModalOpen(true);
      return () => setModalOpen(false);
    }
  }, [directorOverlayOpen, setModalOpen]);

  // 加载门：会话 ready（租约 + 初始内容就绪）且持久化设置齐备才放行画布。
  // 画布主体存入 stage：过期弹窗渲染在 return 顶层（加载门之外）——加载期间
  // 编辑权被其他实例取得（SPA 返回遇上 superseded 只收 evict）时，弹窗必须
  // 已可见，而不是被加载门挡住导致永久悬置
  const stage =
    session !== "ready" || settingsStatus !== "ready" ? (
      <CanvasLoader
        failed={settingsStatus === "failed"}
        onRetry={settingsStatus === "failed" ? retrySettings : undefined}
      />
    ) : (
      <ReactFlowProvider>
      <AppShell>
        <CanvasWithKeyboard />
      </AppShell>

      {/* Shortcuts help modal */}
      <Dialog open={shortcutsVisible} onOpenChange={(nextOpen) => { if (!nextOpen) setShortcutsVisible(false); }}>
        <DialogContent className="sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle>{t("shortcuts.title")}</DialogTitle>
          </DialogHeader>
          {(() => {
          const kb = (v: string) => <kbd className="bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded text-xs font-mono">{v}</kbd>;
          const row = (key: string, desc: string) => <div>{kb(key)} {desc}</div>;
          return (
            <div className="space-y-3" style={{ color: "var(--foreground)" }}>
              <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted-foreground)" }}>{t("shortcuts.zoom")}</div>
              <div className="grid grid-cols-2 gap-1.5 text-sm">
                {row("Scroll", t("shortcuts.desc.scroll"))}
                {row(t("shortcuts.key.spaceDrag"), t("shortcuts.desc.pan"))}
                {row(t("shortcuts.key.middleDrag"), t("shortcuts.desc.pan"))}
                {row(modKey("="), t("shortcuts.desc.zoomin"))}
                {row(modKey("-"), t("shortcuts.desc.zoomout"))}
                {row(modKey("0"), t("shortcuts.desc.reset"))}
                {row(modKey("M"), t("shortcuts.desc.minimap"))}
              </div>
              <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted-foreground)" }}>{t("shortcuts.edit")}</div>
              <div className="grid grid-cols-2 gap-1.5 text-sm">
                {row(t("shortcuts.key.drag"), t("shortcuts.desc.selectRegion"))}
                {row(modKey("A"), t("shortcuts.desc.selectall"))}
                {row(t("shortcuts.key.shiftClick"), t("shortcuts.desc.multiselect"))}
                {row(modKey("C"), t("shortcuts.desc.copy"))}
                {row(modKey("V"), t("shortcuts.desc.paste"))}
                {row("Delete", t("shortcuts.desc.delete"))}
                {row("Escape", t("shortcuts.desc.esc"))}
              </div>
              <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted-foreground)" }}>{t("shortcuts.group")}</div>
              <div className="grid grid-cols-2 gap-1.5 text-sm">
                {row(modKey("G"), t("shortcuts.desc.group"))}
                {row(modKey("Shift+G"), t("shortcuts.desc.ungroup"))}
                {row(modKey("Z"), t("shortcuts.desc.undo"))}
                {row(modKey("Shift+Z"), t("shortcuts.desc.redo"))}
              </div>
              <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted-foreground)" }}>{t("shortcuts.other")}</div>
              <div className="space-y-1 text-xs" style={{ color: "var(--muted-foreground)" }}>
                <div>? — {t("shortcuts.desc.help")}</div>
                <div>{t("drop.upload")}</div>
              </div>
            </div>
          );
          })()}
        </DialogContent>
      </Dialog>

      {/* Director fullscreen overlay */}
      {directorOverlayOpen && (
        <DirectorOverlay onClose={() => setDirectorOverlayOpen(false)} />
      )}
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
