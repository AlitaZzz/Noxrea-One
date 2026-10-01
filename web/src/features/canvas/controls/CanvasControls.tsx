/**
 * 画布右下角控制条。
 * 提供缩放调节、适应视图、网格背景切换、吸附开关与语言切换，
 * 以及资产库 / 渠道配置 / 侧边栏的打开入口；偏好项变更会同步保存到用户配置。
 */
"use client";

import {
  ApiOutlined,
  BgColorsOutlined,
  ExpandOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";
import { useReactFlow, useViewport } from "@xyflow/react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import AppButton from "@/components/ui/AppButton";
import AppDropdown from "@/components/ui/AppDropdown";
import type { AppMenuProps } from "@/components/ui/AppMenu";
import AppNumberInput from "@/components/ui/AppNumberInput";
import AppPopover from "@/components/ui/AppPopover";
import AppTooltip from "@/components/ui/AppTooltip";
import { AssetsIcon } from "@/components/ui/icons/canvas/AssetsIcon";
import { MagnetIcon } from "@/components/ui/icons/canvas/MagnetIcon";
import { MapPinIcon } from "@/components/ui/icons/canvas/MapPinIcon";
import { PanelIcon } from "@/components/ui/icons/canvas/PanelIcon";
import { ShortcutIcon } from "@/components/ui/icons/canvas/ShortcutIcon";
import { useAuthStore } from "@/features/auth/store";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { BackgroundType } from "@/features/canvas/types";
import { MAX_ZOOM,MIN_ZOOM } from "@/lib/constants";
import { modKey } from "@/lib/platform";

function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const toggle = () => {
    const next = lang === "zh" ? "en" : "zh";
    useAuthStore.getState().savePreference("language", next);
  };
  return (
    <AppTooltip title={t("common.switchLanguage")}>
      <AppButton
        size="sm"
        variant="ghost"
        className="canvas-ctrl-btn"
        onClick={toggle}
        style={{ fontSize: 12, fontWeight: 600, minWidth: 28 }}
      >
        {lang === "zh" ? "EN" : "中"}
      </AppButton>
    </AppTooltip>
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
  const setBackground = useCanvasStore((s) => s.setBackground);

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

  const zoomItems: NonNullable<AppMenuProps["items"]> = [
    {
      key: "zoom-input",
      type: "group",
      label: (
        <div style={{ width: 170, paddingBottom: 4 }}>
          <AppNumberInput
            size="small" controls={false}
            min={Math.round(MIN_ZOOM * 100)} max={Math.round(MAX_ZOOM * 100)}
            value={inputZoom} placeholder="100" autoFocus
            className="zoom-input"
            style={{ width: "100%" }}
            suffix={<span style={{ color: "var(--canvas-text-dim)", fontSize: 13 }}>%</span>}
            onChange={(v) => { if (v != null) setInputZoom(v); }}
            onPressEnter={() => handleZoomInput(inputZoom)} />
        </div>
      ),
    },
    { type: "divider" },
    { key: "in", icon: <ZoomInOutlined />, label: t("canvas.zoom.in") },
    { key: "out", icon: <ZoomOutOutlined />, label: t("canvas.zoom.out") },
    { key: "fit", icon: <ExpandOutlined />, label: t("canvas.fit") },
    { type: "divider" },
    { key: "50", label: t("canvas.zoom.to50") },
    { key: "100", label: t("canvas.zoom.to100") },
  ];

  return (
    <>
      <div
        className="canvas-ctrl-bar flex items-center gap-1 px-1.5 rounded-lg shadow-lg w-fit"
        style={{
          height: 40,
          // 磨砂玻璃：背景 70% 不透明度 + 背景模糊，透出并柔化画布内容
          background: "color-mix(in srgb, var(--canvas-bg, #262626) 70%, transparent)",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          border: "1px solid var(--canvas-border, #3a3a3a)",
          // 外层 Panel 为 pointer-events: none，这里恢复自身（含内部浮层）的交互
          pointerEvents: "auto",
        }}
      >
        {/* Canvas Explorer — 最左侧主面板开关。
            按钮同时有图标和文字「面板」，再挂 tooltip 属于重复提示，去掉 */}
        <AppButton
          size="sm"
          variant="ghost"
          className={`canvas-ctrl-btn${canvasExplorerOpen ? " canvas-ctrl-active" : ""}`}
          aria-pressed={canvasExplorerOpen}
          onClick={onOpenCanvasExplorer}
        >
          <PanelIcon />
          {t("canvas.panel")}
        </AppButton>

        {/* Minimap toggle */}
        <AppTooltip title={minimapVisible ? t("canvas.minimap.hide") : t("canvas.minimap.show")}>
          <AppButton
            size="sm"
            variant="ghost"
            iconOnly
            className={`canvas-ctrl-btn ${minimapVisible ? "canvas-ctrl-active" : ""}`}
            aria-pressed={minimapVisible}
            onClick={() => { toggleMinimap(); }}
          >
            <MapPinIcon />
          </AppButton>
        </AppTooltip>

        {/* Snap to grid toggle */}
        <AppTooltip title={snapToGrid ? t("canvas.snap.on") : t("canvas.snap.off")}>
          <AppButton
            size="sm"
            variant="ghost"
            iconOnly
            className={`canvas-ctrl-btn ${snapToGrid ? "canvas-ctrl-active" : ""}`}
            aria-pressed={snapToGrid}
            onClick={() => { toggleSnapToGrid(); }}
          >
            <MagnetIcon />
          </AppButton>
      </AppTooltip>

      {/* Background picker */}
      <AppDropdown
        open={bgOpen}
        onOpenChange={setBgOpen}
        placement="top"
        trigger={["click"]}
        menu={{
          items: (["dots", "grid", "blank"] as BackgroundType[]).map((bg) => ({
            key: bg,
            label: t(`canvas.background.${bg}`),
          })),
          onClick: ({ key }) => setBackground(key as BackgroundType),
        }}
      >
        <AppTooltip title={t("common.background")}>
          <AppButton size="sm" variant="ghost" iconOnly className="canvas-ctrl-btn"><BgColorsOutlined /></AppButton>
        </AppTooltip>
      </AppDropdown>
      {/* Language toggle */}
      <LanguageToggle />

      {/* API Settings */}
      <AppTooltip title={t("modelConfig.apiSettings")}>
        <AppButton size="sm" variant="ghost" iconOnly className="canvas-ctrl-btn" onClick={onOpenSettings}><ApiOutlined /></AppButton>
      </AppTooltip>

      {/* My Assets */}
      <AppTooltip title={t("common.assets")}>
        <AppButton size="sm" variant="ghost" iconOnly className="canvas-ctrl-btn" onClick={onOpenAssets}><AssetsIcon /></AppButton>
      </AppTooltip>

      <span className="canvas-toolbar-sep" style={{ height: 18 }} />

      {/* Shortcuts — 快捷键速查，随按钮锚定弹出（与背景/缩放菜单同交互）。
          多列速查表是面板而非列表菜单，走 antd Popover + panel-popover 壳 */}
      <AppPopover
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        placement="top"
        trigger={["click"]}
        arrow={false}
        contentStyle={{ padding: 0, background: "transparent" }}
        content={
          <div className="panel-popover" style={{ padding: 0 }}>
            <div className="flex gap-10 p-6 select-none" style={{ color: "var(--canvas-text-dim)" }}>
              {[
                { title: t("shortcuts.zoom"), items: [[modKey("="), t("shortcuts.desc.zoomin")], [modKey("-"), t("shortcuts.desc.zoomout")], [modKey("0"), t("shortcuts.desc.reset")], [t("shortcuts.key.scroll"), t("shortcuts.desc.scroll")]] },
                { title: t("shortcuts.pan"), items: [[t("shortcuts.key.spaceDrag"), t("shortcuts.desc.pan")], [t("shortcuts.key.middleDrag"), t("shortcuts.desc.pan")]] },
                { title: t("shortcuts.edit"), items: [[t("shortcuts.key.drag"), t("shortcuts.desc.selectRegion")], [modKey("C"), t("shortcuts.desc.copy")], [modKey("V"), t("shortcuts.desc.paste")], [modKey("Z"), t("shortcuts.desc.undo")], [modKey("Shift+Z"), t("shortcuts.desc.redo")], ["Delete", t("shortcuts.desc.delete")]] },
                { title: t("shortcuts.group"), items: [[modKey("G"), t("shortcuts.desc.group")], [modKey("Shift+G"), t("shortcuts.desc.ungroup")]] },
                { title: t("shortcuts.other"), items: [[modKey("A"), t("shortcuts.desc.selectall")], [modKey("M"), t("shortcuts.desc.minimap")], [t("shortcuts.key.shiftClick"), t("shortcuts.desc.multiselect")], ["Escape", t("shortcuts.desc.esc")], ["?", t("shortcuts.desc.help")]] },
              ].map((group, i, arr) => (
                <div key={group.title} className={`${i < arr.length - 1 ? "border-r border-[var(--canvas-border-light)] pr-10" : ""}`} style={{ width: 200, flexShrink: 0 }}>
                  <div className="text-[var(--canvas-text-muted)] text-sm font-medium mb-3">{group.title}</div>
                  {group.items.map(([key, desc]) => (
                    <div key={key} className="flex items-center justify-between gap-3 py-2">
                      <kbd className="bg-[var(--canvas-bg-active)] px-2.5 py-1 rounded text-sm font-mono text-[var(--canvas-text)] whitespace-nowrap">{key}</kbd>
                      <span className="text-sm text-right">{desc}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        }
      >
        <AppTooltip title={t("shortcuts.title")}>
          <AppButton size="sm" variant="ghost" iconOnly className="canvas-ctrl-btn"><ShortcutIcon style={{ width: 16, height: 16 }} /></AppButton>
        </AppTooltip>
      </AppPopover>

      {/* Agent 对话 */}
      {/* Zoom display + menu */}
      <AppDropdown
        open={zoomOpen}
        onOpenChange={(v) => {
          setZoomOpen(v);
          if (v) setInputZoom(Math.round(viewport.zoom * 100));
        }}
        placement="top"
        trigger={["click"]}
        menu={{
          items: zoomItems,
          onClick: ({ key }) => {
            if (key === "in") zoomIn();
            else if (key === "out") zoomOut();
            else if (key === "fit") fitView({ duration: 300 });
            else if (key === "50") handleZoomTo(50);
            else if (key === "100") handleZoomTo(100);
          },
        }}
      >
        <AppButton size="sm" variant="ghost" className="canvas-ctrl-btn" style={{ minWidth: 48, fontVariantNumeric: "tabular-nums" }}>
          {zoomPercent}%
        </AppButton>
      </AppDropdown>
    </div>
    </>
  );
}
