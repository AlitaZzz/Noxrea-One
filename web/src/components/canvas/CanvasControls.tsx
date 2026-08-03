"use client";

import {
  AimOutlined,
  BgColorsOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ExpandOutlined,
  ApiOutlined,
  MedicineBoxOutlined, // unused — kept for other components
  MoonOutlined,
  SunOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";
import { useReactFlow } from "@xyflow/react";
import { Button, InputNumber,Popover, Tooltip } from "antd";
import { useCallback,useState } from "react";

import { MenuDivider, MenuItem, MenuPopover } from "@/components/common/MenuPopover";
import { AssetsIcon } from "@/components/common/icons/AssetsIcon";
import { MagnetIcon } from "@/components/common/icons/MagnetIcon";
import { MAX_ZOOM,MIN_ZOOM } from "@/lib/constants";
import type { BackgroundType } from "@/lib/types";
import { useAuthStore } from "@/stores/auth-store";
import { useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";

function LanguageToggle() {
  const lang = useI18nStore((s) => s.lang);
  const toggle = useI18nStore((s) => s.toggle);
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
  onOpenCanvasSidebar?: () => void;
  canvasSidebarOpen?: boolean;
}

export default function CanvasControls({ onOpenSettings, onOpenAssets, onOpenCanvasSidebar, canvasSidebarOpen }: Props) {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const t = useI18nStore((s) => s.t);

  const viewport = useCanvasStore((s) => s.viewport);
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
          style={{ width: "100%" }}
          suffix={<span style={{ color: "var(--canvas-text-dim)", fontSize: 13 }}>%</span>}
          onChange={(v) => { if (v != null) { setInputZoom(v); handleZoomInput(v); } }} />
      </div>
      <style>{`.menu-popover-item:hover { background: var(--canvas-bg-hover) !important; }`}</style>
      <MenuItem onClick={() => { zoomIn(); setZoomOpen(false); }}><ZoomInOutlined /> {t("zoom.in")}</MenuItem>
      <MenuItem onClick={() => { zoomOut(); setZoomOpen(false); }}><ZoomOutOutlined /> {t("zoom.out")}</MenuItem>
      <MenuItem onClick={() => { fitView({ duration: 300 }); setZoomOpen(false); }}><ExpandOutlined /> {t("fit")}</MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => handleZoomTo(50)}>{t("zoom.to.50")}</MenuItem>
      <MenuItem onClick={() => handleZoomTo(100)}>{t("zoom.to.100")}</MenuItem>
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
      `}</style>
      <div
        className="flex items-center gap-1 px-1.5 py-1 rounded-lg shadow-lg w-fit"
        style={{
          background: "var(--canvas-bg, #262626)",
          border: "1px solid var(--canvas-border, #3a3a3a)",
        }}
      >
        {/* Canvas Sidebar — 最左侧主面板开关（图标+文字） */}
        <Tooltip title={canvasSidebarOpen ? t("canvas.closeSidebar") : t("canvas.openSidebar")}>
          <Button
            size="small"
            type="text"
            className={`canvas-ctrl-btn${canvasSidebarOpen ? " canvas-ctrl-active" : ""}`}
            icon={canvasSidebarOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
            onClick={onOpenCanvasSidebar}
          >
            {t("canvas.panel")}
          </Button>
        </Tooltip>

        {/* Minimap toggle */}
        <Tooltip title={minimapVisible ? t("minimap.hide") : t("minimap.show")}>
          <Button
            size="small"
            type="text"
            className={`canvas-ctrl-btn ${minimapVisible ? "canvas-ctrl-active" : ""}`}
            icon={<AimOutlined />}
            onClick={() => { toggleMinimap(); }}
          />
        </Tooltip>

        {/* Snap to grid toggle */}
        <Tooltip title={snapToGrid ? t("snap.on") : t("snap.off")}>
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
          <Tooltip title={t("background")}>
            <Button size="small" type="text" className="canvas-ctrl-btn" icon={<BgColorsOutlined />} />
          </Tooltip>
        }
        placement="top"
        content={(["dots", "grid", "blank"] as BackgroundType[]).map((bg) => (
          <MenuItem key={bg} onClick={() => { setBackground(bg); setBgOpen(false); }}>{t(bg)}</MenuItem>
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
      <Tooltip title={t("api.settings")}>
        <Button size="small" type="text" className="canvas-ctrl-btn" icon={<ApiOutlined />} onClick={onOpenSettings} />
      </Tooltip>

      {/* My Assets */}
      <Tooltip title={t("assets")}>
        <Button size="small" type="text" className="canvas-ctrl-btn" icon={<AssetsIcon />} onClick={onOpenAssets} />
      </Tooltip>

      {/* Zoom display + menu */}
      <Popover
        content={zoomMenu}
        trigger="click"
        open={zoomOpen}
        onOpenChange={(v) => {
          setZoomOpen(v);
          if (v) setInputZoom(Math.round(useCanvasStore.getState().viewport.zoom * 100));
        }}
        placement="top"
        styles={{ container: { padding: 12, background: "var(--canvas-bg, #262626)" } }}
      >
        <Button size="small" type="text" className="canvas-ctrl-btn" style={{ minWidth: 48, fontVariantNumeric: "tabular-nums" }}>
          {zoomPercent}%
        </Button>
      </Popover>
    </div>
    </>
  );
}
