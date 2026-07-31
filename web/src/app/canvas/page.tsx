"use client";

import { ReactFlowProvider } from "@xyflow/react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import InfiniteCanvas from "@/components/canvas/InfiniteCanvas";
import AppShell from "@/components/layout/AppShell";
import { useCanvasKeyboard } from "@/hooks/use-canvas-keyboard";
import { LayerModal } from "@/lib/layer";
import { useAuthStore } from "@/stores/auth-store";
import { useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";
import { useProjectStore } from "@/stores/project-store";

const DirectorOverlay = dynamic(
  () => import("@/components/director/DirectorOverlay"),
  { ssr: false }
);

function CanvasWithKeyboard() {
  useCanvasKeyboard();
  return <InfiniteCanvas />;
}

export default function HomePage() {
  const t = useI18nStore((s) => s.t);
  const initialize = useProjectStore((s) => s.initialize);
  const activeProject = useProjectStore((s) => s.activeProject);
  const shortcutsVisible = useCanvasStore((s) => s.shortcutsVisible);
  const setShortcutsVisible = useCanvasStore((s) => s.setShortcutsVisible);
  const directorOverlayOpen = useCanvasStore((s) => s.directorOverlayOpen);
  const setDirectorOverlayOpen = useCanvasStore((s) => s.setDirectorOverlayOpen);
  const setModalOpen = useCanvasStore((s) => s.setModalOpen);
  const [initialized, setInitialized] = useState(false);

  // Initialize auth first, then projects
  useEffect(() => {
    const init = async () => {
      await useAuthStore.getState().initialize();
      if (!useAuthStore.getState().user) { window.location.href = "/login"; return; }
      // Sync theme & lang from user prefs
      const u = useAuthStore.getState().user!;
      useCanvasStore.getState().setTheme(u.theme === "light" ? "light" : "dark");
      useI18nStore.getState().setLang((u.lang || "zh") as "zh" | "en");
      await initialize();
      const project = useProjectStore.getState().activeProject();
      if (!project) { window.location.href = "/project"; return; }
      if (project) { useCanvasStore.getState().restoreFromProject(project); }
      setInitialized(true);
    };
    init();
  }, [initialize]);

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
        title={<span style={{ color: "var(--canvas-text)" }}>{t("shortcuts")}</span>}
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
    </ReactFlowProvider>
  );
}
