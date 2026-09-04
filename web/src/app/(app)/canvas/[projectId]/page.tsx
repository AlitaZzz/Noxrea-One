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
import ConfirmModal from "@/components/ui/ConfirmModal";
import { LayerModal } from "@/components/ui/modal/LayerModal";
import { useCanvasKeyboard } from "@/features/canvas/hooks/use-canvas-keyboard";
import InfiniteCanvas from "@/features/canvas/InfiniteCanvas";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { clearDraft, loadDraft, type DraftRecord } from "@/features/project/draft-store";
import { useProjectStore } from "@/features/project/store";

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
  const [initialized, setInitialized] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState<DraftRecord | null>(null);

  // 鉴权与项目列表初始化已由 (app)/layout.tsx 统一完成。
  // URL 是项目身份的真相源：先同步进 store（save-manager 按 activeProjectId 存盘），
  // 再从服务器拉取最新项目数据恢复到画布，
  // 避免多浏览器 / 多 Tab 场景下本地缓存过期导致数据不一致。
  useEffect(() => {
    if (!projectId) {
      window.location.href = "/project";
      return;
    }
    useProjectStore.getState().setActiveProject(projectId);
    useProjectStore.getState().refreshProject(projectId).then(async (project) => {
      if (!project) {
        window.location.href = "/project";
        return;
      }
      // 先用后端数据渲染画布，再检查是否有比后端更新的离线草稿（弹窗询问）
      useCanvasStore.getState().restoreFromProject(project);
      setInitialized(true);

      const draft = await loadDraft(projectId);
      if (draft && draft.updatedAt > project.updatedAt) {
        setDraftPrompt(draft);
      }
    });
  }, [projectId]);

  /** 恢复离线草稿：用草稿覆盖画布并触发重新落库 */
  const handleRestoreDraft = useCallback(() => {
    if (!draftPrompt) return;
    useCanvasStore.getState().restoreFromProject(draftPrompt.canvasData);
    markDirtyImmediate();
    void clearDraft(projectId);
    setDraftPrompt(null);
  }, [draftPrompt, projectId]);

  /** 丢弃离线草稿：保留后端数据 */
  const handleDiscardDraft = useCallback(() => {
    if (!draftPrompt) return;
    void clearDraft(projectId);
    setDraftPrompt(null);
  }, [draftPrompt, projectId]);

  // Sync modalOpen when director overlay is open (blocks canvas shortcuts)
  useEffect(() => {
    if (directorOverlayOpen) {
      setModalOpen(true);
      return () => setModalOpen(false);
    }
  }, [directorOverlayOpen, setModalOpen]);

  if (!initialized) {
    return (
      <div className="flex items-center justify-center h-screen w-screen bg-[#0d0d0d] text-white">
        <div className="text-lg">Loading canvas...</div>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <AppShell>
        <CanvasWithKeyboard />
      </AppShell>

      {/* Shortcuts help modal */}
      <LayerModal
        title={<span style={{ color: "var(--canvas-text)" }}>{t("shortcuts.title")}</span>}
        open={shortcutsVisible}
        onCancel={() => setShortcutsVisible(false)}
        footer={null}
        width={620}
      >
        {(() => {
          const kb = (v: string) => <kbd className="bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded text-xs font-mono">{v}</kbd>;
          const row = (key: string, desc: string) => <div>{kb(key)} {desc}</div>;
          return (
            <div className="space-y-3" style={{ color: "var(--canvas-text)" }}>
              <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--canvas-text-dim)" }}>{t("shortcuts.zoom")}</div>
              <div className="grid grid-cols-2 gap-1.5 text-sm">
                {row("Scroll", t("shortcuts.desc.scroll"))}
                {row("Drag", t("shortcuts.desc.pan"))}
                {row("Ctrl+=", t("shortcuts.desc.zoomin"))}
                {row("Ctrl+-", t("shortcuts.desc.zoomout"))}
                {row("Ctrl+0", t("shortcuts.desc.reset"))}
                {row("Ctrl+M", t("shortcuts.desc.minimap"))}
              </div>
              <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--canvas-text-dim)" }}>{t("shortcuts.edit")}</div>
              <div className="grid grid-cols-2 gap-1.5 text-sm">
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
                <div>{t("shortcuts.desc.temppan")}</div>
                <div>{t("drop.upload")}</div>
              </div>
            </div>
          );
        })()}
      </LayerModal>

      {/* Director fullscreen overlay */}
      {directorOverlayOpen && (
        <DirectorOverlay onClose={() => setDirectorOverlayOpen(false)} />
      )}

      {/* 离线草稿恢复确认 */}
      <ConfirmModal
        open={!!draftPrompt}
        title={t("draft.title")}
        content={t("draft.content")}
        okText={t("draft.restore")}
        cancelText={t("draft.discard")}
        onOk={handleRestoreDraft}
        onCancel={handleDiscardDraft}
      />
    </ReactFlowProvider>
  );
}
