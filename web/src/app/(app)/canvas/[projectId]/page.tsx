/**
 * 画布页面（/canvas/[projectId]）。
 * 以 URL 上的项目 ID 作为项目身份的唯一真相源：拉取该项目并恢复到画布状态，
 * 装配 ReactFlowProvider、AppShell 与画布主体，并挂载两个页面级浮层：
 * 快捷键说明弹窗、Director 全屏编辑器。
 * ID 缺失、或项目不存在 / 不属于当前用户时回退到 /project。
 */
"use client";

import { ReactFlowProvider } from "@xyflow/react";
import dynamic from "next/dynamic";
import { use, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import AppShell from "@/components/layout/AppShell";
import AppModal from "@/components/ui/AppModal";
import CanvasLoader from "@/components/ui/CanvasLoader";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { useCanvasKeyboard } from "@/features/canvas/hooks/use-canvas-keyboard";
import InfiniteCanvas from "@/features/canvas/InfiniteCanvas";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useSessionExpiredStore } from "@/features/project/session-expired-store";
import { useProjectStore } from "@/features/project/store";
import { useCanvasSession } from "@/features/project/use-canvas-session";

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
  // 记录「已成功加载并恢复到画布」的项目 ID：
  // 用它与 URL 上的 projectId 比较得到加载态，切换项目时会自动回到 Loading，
  // 避免短暂渲染上一个项目的画布内容，也避免在 effect 体内同步 setState。
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  // 会话过期（画布编辑权被其他页面实例取得）：唯一出口是刷新页面
  const sessionExpired = useSessionExpiredStore((s) => s.expired);

  // 编辑权事件流：其他标签页 / 浏览器进入即抢占，本页立即收到 evict 弹提示，
  // 不等到保存撞 409 才发现。本 hook 独立于项目加载，抢占感知尽可能早。
  useCanvasSession(projectId);

  // 鉴权与项目列表初始化已由 (app)/layout.tsx 统一完成。
  // URL 是项目身份的真相源：先同步进 store，再从服务器拉取最新项目数据恢复到画布，
  // 避免多浏览器 / 多 Tab 场景下本地缓存过期导致数据不一致。
  useEffect(() => {
    if (!projectId) {
      window.location.href = "/project";
      return;
    }
    useProjectStore.getState().setActiveProject(projectId);
    useProjectStore.getState().refreshProject(projectId).then((project) => {
      if (!project) {
        window.location.href = "/project";
        return;
      }
      // 后端数据是唯一真相源：刷新后一律以服务端内容渲染画布。
      // 被抢占期间产生的本地改动随之作废（不再有离线草稿机制兜底）。
      useCanvasStore.getState().restoreFromProject(project.id, project);
      setLoadedProjectId(projectId);
    }).catch((err) => {
      // 拉取 / 解析失败时不能停在 "Loading canvas..."，回到项目列表
      console.error("[canvas] load project failed:", err);
      window.location.href = "/project";
    });
  }, [projectId]);

  // Sync modalOpen when director overlay is open (blocks canvas shortcuts)
  useEffect(() => {
    if (directorOverlayOpen) {
      setModalOpen(true);
      return () => setModalOpen(false);
    }
  }, [directorOverlayOpen, setModalOpen]);

  if (loadedProjectId !== projectId) {
    return <CanvasLoader />;
  }

  return (
    <ReactFlowProvider>
      <AppShell>
        <CanvasWithKeyboard />
      </AppShell>

      {/* Shortcuts help modal */}
      <AppModal
        title={<span style={{ color: "var(--canvas-text)" }}>{t("shortcuts.title")}</span>}
        open={shortcutsVisible}
        onCancel={() => setShortcutsVisible(false)}
        footer={null}
        width={620}
        styles={{ body: { padding: "16px 24px 24px" } }}
      >
        {(() => {
          const kb = (v: string) => <kbd className="bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded text-xs font-mono">{v}</kbd>;
          const row = (key: string, desc: string) => <div>{kb(key)} {desc}</div>;
          return (
            <div className="space-y-3" style={{ color: "var(--canvas-text)" }}>
              <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--canvas-text-dim)" }}>{t("shortcuts.zoom")}</div>
              <div className="grid grid-cols-2 gap-1.5 text-sm">
                {row("Scroll", t("shortcuts.desc.scroll"))}
                {row(t("shortcuts.key.spaceDrag"), t("shortcuts.desc.pan"))}
                {row(t("shortcuts.key.middleDrag"), t("shortcuts.desc.pan"))}
                {row("Ctrl+=", t("shortcuts.desc.zoomin"))}
                {row("Ctrl+-", t("shortcuts.desc.zoomout"))}
                {row("Ctrl+0", t("shortcuts.desc.reset"))}
                {row("Ctrl+M", t("shortcuts.desc.minimap"))}
              </div>
              <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--canvas-text-dim)" }}>{t("shortcuts.edit")}</div>
              <div className="grid grid-cols-2 gap-1.5 text-sm">
                {row(t("shortcuts.key.drag"), t("shortcuts.desc.selectRegion"))}
                {row("Ctrl+A", t("shortcuts.desc.selectall"))}
                {row(t("shortcuts.key.shiftClick"), t("shortcuts.desc.multiselect"))}
                {row("Ctrl+C", t("shortcuts.desc.copy"))}
                {row("Ctrl+V", t("shortcuts.desc.paste"))}
                {row("Delete", t("shortcuts.desc.delete"))}
                {row("Escape", t("shortcuts.desc.esc"))}
              </div>
              <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--canvas-text-dim)" }}>{t("shortcuts.group")}</div>
              <div className="grid grid-cols-2 gap-1.5 text-sm">
                {row("Ctrl+G", t("shortcuts.desc.group"))}
                {row("Ctrl+Shift+G", t("shortcuts.desc.ungroup"))}
                {row("Ctrl+Z", t("shortcuts.desc.undo"))}
                {row("Ctrl+Shift+Z", t("shortcuts.desc.redo"))}
              </div>
              <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--canvas-text-dim)" }}>{t("shortcuts.other")}</div>
              <div className="space-y-1 text-xs" style={{ color: "var(--canvas-text-muted)" }}>
                <div>? — {t("shortcuts.desc.help")}</div>
                <div>{t("drop.upload")}</div>
              </div>
            </div>
          );
        })()}
      </AppModal>

      {/* Director fullscreen overlay */}
      {directorOverlayOpen && (
        <DirectorOverlay onClose={() => setDirectorOverlayOpen(false)} />
      )}

      {/* 会话过期：不可关闭，唯一动作是刷新；刷新即新页面实例，重新取得编辑权 */}
      <ConfirmModal
        open={sessionExpired}
        title={t("conflict.title")}
        content={t("conflict.content")}
        okText={t("conflict.reload")}
        hideCancel
        onOk={() => window.location.reload()}
        onCancel={() => window.location.reload()}
      />
    </ReactFlowProvider>
  );
}
