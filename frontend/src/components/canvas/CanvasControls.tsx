"use client";

import { useState, useCallback } from "react";
import { useReactFlow } from "@xyflow/react";
import { Button, Popover, Tooltip } from "antd";
import { MenuItem, MenuDivider, MenuPopover } from "@/components/common/MenuPopover";
import {
  AimOutlined,
  MedicineBoxOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  ExpandOutlined,
  BgColorsOutlined,
  SunOutlined,
  MoonOutlined,
  SettingOutlined,
  InboxOutlined,
} from "@ant-design/icons";
import type { BackgroundType } from "@/lib/types";
import { useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";
import { useAuthStore } from "@/stores/auth-store";
import { MIN_ZOOM, MAX_ZOOM } from "@/lib/constants";

function LanguageToggle() {
  const lang = useI18nStore((s) => s.lang);
  const toggle = useI18nStore((s) => s.toggle);
  return (
    <Tooltip title={lang === "zh" ? "Switch to English" : "切换到中文"}>
      <Button
        size="small"
        type="text"
        className="canvas-ctrl-btn"
        onClick={() => { toggle(); useAuthStore.getState().savePreference("lang", lang === "zh" ? "en" : "zh"); }}
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
}

export default function CanvasControls({ onOpenSettings, onOpenAssets }: Props) {
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
      <div style={{ position: "relative", marginBottom: 4 }}>
        <input
          type="number"
          min={Math.round(MIN_ZOOM * 100)}
          max={Math.round(MAX_ZOOM * 100)}
          value={inputZoom}
          onChange={(e) => setInputZoom(Number(e.target.value))}
          onKeyDown={(e) => { if (e.key === "Enter") handleZoomInput(inputZoom); }}
          placeholder="100"
          autoFocus
          className="zoom-input-no-spin"
          style={{
            width: "100%",
            padding: "4px 28px 4px 8px",
            background: "var(--canvas-bg-elevated, #333)",
            border: "1px solid #444",
            borderRadius: 4,
            color: "var(--canvas-text)",
            fontSize: 13,
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        <span
          style={{
            position: "absolute",
            right: 8,
            top: "50%",
            transform: "translateY(-50%)",
            color: "var(--canvas-text-dim)",
            fontSize: 13,
            pointerEvents: "none",
          }}
        >
          %
        </span>
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
        .zoom-input-no-spin::-webkit-outer-spin-button,
        .zoom-input-no-spin::-webkit-inner-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        .zoom-input-no-spin[type=number] {
          -moz-appearance: textfield;
        }
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
            icon={<MedicineBoxOutlined />}
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

      {/* Settings */}
      <Tooltip title={t("settings")}>
        <Button size="small" type="text" className="canvas-ctrl-btn" icon={<SettingOutlined />} onClick={onOpenSettings} />
      </Tooltip>

      {/* My Assets */}
      <Tooltip title={t("assets")}>
        <Button size="small" type="text" className="canvas-ctrl-btn" icon={<InboxOutlined />} onClick={onOpenAssets} />
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
