/**
 * 画布右下角控制条。
 * 提供缩放调节、适应视图、网格背景切换、吸附开关、主题与语言切换，
 * 以及资产库 / 渠道配置 / 侧边栏的打开入口；偏好项变更会同步保存到用户配置。
 */
"use client";

import {
  AimOutlined,
  ApiOutlined,
  BgColorsOutlined,
  ExpandOutlined,
  MedicineBoxOutlined, // unused — kept for other components
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoonOutlined,
  SunOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";
import { useReactFlow, useViewport } from "@xyflow/react";
import { Button, InputNumber, Tooltip } from "antd";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { AssetsIcon } from "@/components/ui/icons/canvas/AssetsIcon";
import { MagnetIcon } from "@/components/ui/icons/canvas/MagnetIcon";
import { ShortcutIcon } from "@/components/ui/icons/canvas/ShortcutIcon";
import { MenuDivider, MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import { useAuthStore } from "@/features/auth/store";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { BackgroundType } from "@/features/canvas/types";
import { MAX_ZOOM,MIN_ZOOM } from "@/lib/constants";

function LanguageToggle() {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  const toggle = () => i18n.changeLanguage(lang === "zh" ? "en" : "zh");
  return (
    <Tooltip title={lang === "zh" ? "Switch to English" : "切换到中文"}>
      <Button
        size="small"
        type="text"
        className="canvas-ctrl-btn"
        onClick={() => { toggle(); useAuthStore.getState().savePreference("language", lang === "zh" ? "en" : "zh"); }}
        style={{ fontSize: 11, fontWeight: 600, minWidth: 28 }}
      >
        {lang === "zh" ? "EN" : "中"}
      </Button>
    </Tooltip>
  );
}

interface Props {
  onOpenSettings?: () => void;
  onOpenAssets?: () => void;
  onOpenCanvasExplorer?: () => void;
  canvasExplorerOpen?: boolean;
}

export default function CanvasControls({ onOpenSettings, onOpenAssets, onOpenCanvasExplorer, canvasExplorerOpen }: Props) {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const { t } = useTranslation();

  const viewport = useViewport();
  const minimapVisible = useCanvasStore((s) => s.minimapVisible);
  const toggleMinimap = useCanvasStore((s) => s.toggleMinimap);
  const snapToGrid = useCanvasStore((s) => s.snapToGrid);
  const toggleSnapToGrid = useCanvasStore((s) => s.toggleSnapToGrid);
  const background = useCanvasStore((s) => s.background);
  const setBackground = useCanvasStore((s) => s.setBackground);
  const theme = useCanvasStore((s) => s.theme);
  const toggleTheme = useCanvasStore((s) => s.toggleTheme);

  const [zoomOpen, setZoomOpen] = useState(false);
  const [bgOpen, setBgOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [inputZoom, setInputZoom] = useState(Math.round(viewport.zoom * 100));

  const handleZoomInput = useCallback(
    (value: number | null) => {
      if (value == null) return;
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value / 100));
      zoomTo(clamped);
      setZoomOpen(false);
    },
    [zoomTo]
  );

  const handleZoomTo = useCallback(
    (percent: number) => {
      zoomTo(percent / 100);
      setZoomOpen(false);
    },
    [zoomTo]
  );

  const zoomPercent = Math.round(viewport.zoom * 100);

  const zoomMenu = (
    <div style={{ width: 170 }}>
      <div style={{ marginBottom: 4 }}>
        <InputNumber
          size="small" controls={false}
          min={Math.round(MIN_ZOOM * 100)} max={Math.round(MAX_ZOOM * 100)}
          value={inputZoom} placeholder="100" autoFocus
          className="zoom-input"
          style={{ width: "100%" }}
          suffix={<span style={{ color: "var(--canvas-text-dim)", fontSize: 13 }}>%</span>}
          onChange={(v) => { if (v != null) setInputZoom(v); }}
          onPressEnter={() => handleZoomInput(inputZoom)} />
      </div>
      <MenuItem onClick={() => { zoomIn(); setZoomOpen(false); }}><ZoomInOutlined /> {t("canvas.zoom.in")}</MenuItem>
      <MenuItem onClick={() => { zoomOut(); setZoomOpen(false); }}><ZoomOutOutlined /> {t("canvas.zoom.out")}</MenuItem>
      <MenuItem onClick={() => { fitView({ duration: 300 }); setZoomOpen(false); }}><ExpandOutlined /> {t("canvas.fit")}</MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => handleZoomTo(50)}>{t("canvas.zoom.to50")}</MenuItem>
      <MenuItem onClick={() => handleZoomTo(100)}>{t("canvas.zoom.to100")}</MenuItem>
    </div>
  );

  return (
    <>
      <style>{`
        .canvas-ctrl-btn.ant-btn-text {
          color: var(--canvas-text);
        }
        .canvas-ctrl-btn.ant-btn-text:hover {
          background: var(--canvas-bg-hover) !important;
          color: var(--canvas-text) !important;
        }
        .canvas-ctrl-btn.ant-btn-text.canvas-ctrl-active {
          background: var(--canvas-bg-hover) !important;
          color: var(--canvas-text) !important;
        }
        .zoom-input.ant-input-number:hover,
        .zoom-input.ant-input-number-focused {
          border-color: var(--canvas-border, #3a3a3a) !important;
          box-shadow: none !important;
        }
      `}</style>
      <div
        className="flex items-center gap-1 px-1.5 py-1 rounded-lg shadow-lg w-fit"
        style={{
          background: "var(--canvas-bg, #262626)",
          border: "1px solid var(--canvas-border, #3a3a3a)",
        }}
      >
        {/* Canvas Explorer — 最左侧主面板开关（图标+文字） */}
        <Tooltip title={canvasExplorerOpen ? t("canvas.closeSidebar") : t("canvas.openSidebar")}>
          <Button
            size="small"
            type="text"
            className={`canvas-ctrl-btn${canvasExplorerOpen ? " canvas-ctrl-active" : ""}`}
            icon={canvasExplorerOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
            onClick={onOpenCanvasExplorer}
          >
            {t("canvas.panel")}
          </Button>
        </Tooltip>

        {/* Minimap toggle */}
        <Tooltip title={minimapVisible ? t("canvas.minimap.hide") : t("canvas.minimap.show")}>
          <Button
            size="small"
            type="text"
            className={`canvas-ctrl-btn ${minimapVisible ? "canvas-ctrl-active" : ""}`}
            icon={<AimOutlined />}
            onClick={() => { toggleMinimap(); }}
          />
        </Tooltip>

        {/* Snap to grid toggle */}
        <Tooltip title={snapToGrid ? t("canvas.snap.on") : t("canvas.snap.off")}>
          <Button
            size="small"
            type="text"
            className={`canvas-ctrl-btn ${snapToGrid ? "canvas-ctrl-active" : ""}`}
            icon={<MagnetIcon />}
            onClick={() => { toggleSnapToGrid(); }}
          />
      </Tooltip>

      {/* Background picker */}
      <MenuPopover open={bgOpen} onOpenChange={setBgOpen}
        trigger={
          <Tooltip title={t("common.background")}>
            <Button size="small" type="text" className="canvas-ctrl-btn" icon={<BgColorsOutlined />} />
          </Tooltip>
        }
        placement="top"
        content={(["dots", "grid", "blank"] as BackgroundType[]).map((bg) => (
          <MenuItem key={bg} onClick={() => { setBackground(bg); setBgOpen(false); }}>{t(`canvas.background.${bg}`)}</MenuItem>
        ))}
      />
      {/* Theme toggle */}
      <Tooltip title={theme === "dark" ? t("theme.light") : t("theme.dark")}>
        <Button
          size="small"
          type="text"
          className="canvas-ctrl-btn"
          icon={theme === "dark" ? <SunOutlined /> : <MoonOutlined />}
          onClick={() => { toggleTheme(); useAuthStore.getState().savePreference("theme", theme === "dark" ? "light" : "dark"); }}
        />
      </Tooltip>

      {/* Language toggle */}
      <LanguageToggle />

      {/* API Settings */}
      <Tooltip title={t("modelConfig.apiSettings")}>
        <Button size="small" type="text" className="canvas-ctrl-btn" icon={<ApiOutlined />} onClick={onOpenSettings} />
      </Tooltip>

      {/* My Assets */}
      <Tooltip title={t("common.assets")}>
        <Button size="small" type="text" className="canvas-ctrl-btn" icon={<AssetsIcon />} onClick={onOpenAssets} />
      </Tooltip>

      <span className="canvas-toolbar-sep" style={{ height: 18 }} />

      {/* Shortcuts — 屏幕居中浮层（非 Modal） */}
      <Tooltip title={t("shortcuts.title")}>
        <Button size="small" type="text" className="canvas-ctrl-btn" icon={<ShortcutIcon style={{ width: 16, height: 16 }} />} onClick={() => setShortcutsOpen((v) => !v)} />
      </Tooltip>
      {shortcutsOpen && (
        <div className="fixed inset-0 z-50" onClick={() => setShortcutsOpen(false)}>
          <div
            className="flex gap-10 p-6 select-none shortcut-fade-in"
            style={{
              position: "fixed",
              bottom: 96,
              left: "50%",
              transform: "translateX(-50%)",
              color: "var(--dir-dim)",
              background: "var(--menu-bg)",
              borderRadius: 12,
              border: "1px solid var(--menu-border)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {[
              { title: t("shortcuts.zoom"), items: [["Ctrl+=", t("shortcuts.desc.zoomin")], ["Ctrl+-", t("shortcuts.desc.zoomout")], ["Ctrl+0", t("shortcuts.desc.reset")], [t("shortcuts.key.scroll"), t("shortcuts.desc.scroll")]] },
              { title: t("shortcuts.pan"), items: [[t("shortcuts.key.drag"), t("shortcuts.desc.pan")], [t("shortcuts.key.spaceDrag"), t("shortcuts.desc.temppan")]] },
              { title: t("shortcuts.edit"), items: [["Ctrl+C", t("shortcuts.desc.copy")], ["Ctrl+V", t("shortcuts.desc.paste")], ["Ctrl+Z", t("shortcuts.desc.undo")], ["Ctrl+Shift+Z", t("shortcuts.desc.redo")], ["Delete", t("shortcuts.desc.delete")]] },
              { title: t("shortcuts.group"), items: [["Ctrl+G", t("shortcuts.desc.group")], ["Ctrl+Shift+G", t("shortcuts.desc.ungroup")]] },
              { title: t("shortcuts.other"), items: [["Ctrl+A", t("shortcuts.desc.selectall")], ["Ctrl+M", t("shortcuts.desc.minimap")], [t("shortcuts.key.shiftClick"), t("shortcuts.desc.multiselect")], ["Escape", t("shortcuts.desc.esc")], ["?", t("shortcuts.desc.help")]] },
            ].map((group, i, arr) => (
              <div key={group.title} className={`${i < arr.length - 1 ? "border-r border-white/10 pr-10" : ""}`} style={{ width: 200, flexShrink: 0 }}>
                <div className="text-white/50 text-sm font-medium mb-3">{group.title}</div>
                {group.items.map(([key, desc]) => (
                  <div key={key} className="flex items-center justify-between gap-3 py-2">
                    <kbd className="bg-white/10 px-2.5 py-1 rounded text-sm font-mono text-white/80 whitespace-nowrap">{key}</kbd>
                    <span className="text-sm text-right">{desc}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent 对话 */}
      {/* Zoom display + menu */}
      <MenuPopover
        open={zoomOpen}
        onOpenChange={(v) => {
          setZoomOpen(v);
          if (v) setInputZoom(Math.round(viewport.zoom * 100));
        }}
        placement="top"
        trigger={
          <Button size="small" type="text" className="canvas-ctrl-btn" style={{ minWidth: 48, fontVariantNumeric: "tabular-nums" }}>
            {zoomPercent}%
          </Button>
        }
        content={zoomMenu}
      />
    </div>
    </>
  );
}
