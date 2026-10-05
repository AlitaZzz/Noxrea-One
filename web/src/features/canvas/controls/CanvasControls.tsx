/**
 * 画布右下角控制条。
 * 提供缩放调节、适应视图、网格背景切换、吸附开关与语言切换，
 * 以及资产库 / 渠道配置 / 侧边栏的打开入口；偏好项变更会同步保存到用户配置。
 */
"use client";

import { useReactFlow, useViewport } from "@xyflow/react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ApiOutlined,
  BgColorsOutlined,
  ExpandOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@/components/ui/AppIcon";
import { AssetsIcon } from "@/components/ui/AppIcon";
import { MagnetIcon } from "@/components/ui/AppIcon";
import { MapPinIcon } from "@/components/ui/AppIcon";
import { PanelIcon } from "@/components/ui/AppIcon";
import { ShortcutIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
    <Tooltip><TooltipTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="min-w-7 text-xs font-semibold"
          onClick={toggle}
        >
          {lang === "zh" ? "EN" : "中"}
        </Button>
      </TooltipTrigger><TooltipContent>{t("common.switchLanguage")}</TooltipContent></Tooltip>
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

  return (
    <>
      <Card className="pointer-events-auto flex h-10 w-fit flex-row items-center gap-1 rounded-lg bg-card/70 px-1.5 py-0 backdrop-blur-[10px]">
        {/* Canvas Explorer — 最左侧主面板开关。
            按钮同时有图标和文字「面板」，再挂 tooltip 属于重复提示，去掉 */}
        <Toggle
          size="sm"
          variant="default"
          pressed={canvasExplorerOpen}
          onPressedChange={(pressed) => {
            if (pressed !== canvasExplorerOpen) onOpenCanvasExplorer?.();
          }}
        >
          <PanelIcon />
          {t("canvas.panel")}
        </Toggle>

        {/* Minimap toggle */}
        <Tooltip><TooltipTrigger asChild>
            <Toggle
              size="sm"
              variant="default"
              className="size-8 p-0"
              pressed={minimapVisible}
              aria-label={minimapVisible ? t("canvas.minimap.hide") : t("canvas.minimap.show")}
              onPressedChange={toggleMinimap}
            >
              <MapPinIcon />
            </Toggle>
          </TooltipTrigger><TooltipContent>{minimapVisible ? t("canvas.minimap.hide") : t("canvas.minimap.show")}</TooltipContent></Tooltip>

        {/* Snap to grid toggle */}
        <Tooltip><TooltipTrigger asChild>
            <Toggle
              size="sm"
              variant="default"
              className="size-8 p-0"
              pressed={snapToGrid}
              aria-label={snapToGrid ? t("canvas.snap.off") : t("canvas.snap.on")}
              onPressedChange={toggleSnapToGrid}
            >
              <MagnetIcon />
            </Toggle>
          </TooltipTrigger><TooltipContent>{snapToGrid ? t("canvas.snap.on") : t("canvas.snap.off")}</TooltipContent></Tooltip>

      {/* Background picker */}
      <DropdownMenu
        open={bgOpen}
        onOpenChange={setBgOpen}
      >
        <Tooltip><TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost">
                <BgColorsOutlined />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger><TooltipContent>{t("common.background")}</TooltipContent></Tooltip>
        <DropdownMenuContent side="top" align="center">
          {(["dots", "grid", "blank"] as BackgroundType[]).map((bg) => (
            <DropdownMenuItem key={bg} onSelect={() => setBackground(bg)}>
              {t(`canvas.background.${bg}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Language toggle */}
      <LanguageToggle />

      {/* API Settings */}
      <Tooltip><TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" onClick={onOpenSettings}><ApiOutlined /></Button>
        </TooltipTrigger><TooltipContent>{t("modelConfig.apiSettings")}</TooltipContent></Tooltip>

      {/* My Assets */}
      <Tooltip><TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" onClick={onOpenAssets}><AssetsIcon /></Button>
        </TooltipTrigger><TooltipContent>{t("common.assets")}</TooltipContent></Tooltip>

      <Separator orientation="vertical" className="mx-1 h-[18px]" />

      {/* Shortcuts — 快捷键速查，使用标准 Popover 锚定工具栏按钮。 */}
      <Popover
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
      >
        <Tooltip><TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button size="icon-sm" variant="ghost">
                <ShortcutIcon className="size-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger><TooltipContent>{t("shortcuts.title")}</TooltipContent></Tooltip>
        <PopoverContent side="top" align="center" className="w-auto p-6">
          <div className="flex gap-10 select-none text-muted-foreground">
            {[
              { title: t("shortcuts.zoom"), items: [[modKey("="), t("shortcuts.desc.zoomin")], [modKey("-"), t("shortcuts.desc.zoomout")], [modKey("0"), t("shortcuts.desc.reset")], [t("shortcuts.key.scroll"), t("shortcuts.desc.scroll")]] },
              { title: t("shortcuts.pan"), items: [[t("shortcuts.key.spaceDrag"), t("shortcuts.desc.pan")], [t("shortcuts.key.middleDrag"), t("shortcuts.desc.pan")]] },
              { title: t("shortcuts.edit"), items: [[t("shortcuts.key.drag"), t("shortcuts.desc.selectRegion")], [modKey("C"), t("shortcuts.desc.copy")], [modKey("V"), t("shortcuts.desc.paste")], [modKey("Z"), t("shortcuts.desc.undo")], [modKey("Shift+Z"), t("shortcuts.desc.redo")], ["Delete", t("shortcuts.desc.delete")]] },
              { title: t("shortcuts.group"), items: [[modKey("G"), t("shortcuts.desc.group")], [modKey("Shift+G"), t("shortcuts.desc.ungroup")]] },
              { title: t("shortcuts.other"), items: [[modKey("A"), t("shortcuts.desc.selectall")], [modKey("M"), t("shortcuts.desc.minimap")], [t("shortcuts.key.shiftClick"), t("shortcuts.desc.multiselect")], ["Escape", t("shortcuts.desc.esc")], ["?", t("shortcuts.desc.help")]] },
            ].map((group, i, arr) => (
              <div key={group.title} className={`w-[200px] shrink-0 ${i < arr.length - 1 ? "border-r pr-10" : ""}`}>
                <div className="mb-3 text-sm font-medium">{group.title}</div>
                {group.items.map(([key, desc]) => (
                  <div key={key} className="flex items-center justify-between gap-3 py-2">
                    <kbd className="whitespace-nowrap rounded bg-secondary px-2.5 py-1 font-mono text-sm text-secondary-foreground">{key}</kbd>
                    <span className="text-right text-sm">{desc}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Agent 对话 */}
      {/* Zoom display + menu */}
      <DropdownMenu
        open={zoomOpen}
        onOpenChange={(v) => {
          setZoomOpen(v);
          if (v) setInputZoom(Math.round(viewport.zoom * 100));
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className="min-w-12 tabular-nums">
            {zoomPercent}%
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="center">
          <DropdownMenuLabel className="p-1.5">
            <div className="w-[170px] pb-1">
              <NumberInput
                controls={false}
                min={Math.round(MIN_ZOOM * 100)}
                max={Math.round(MAX_ZOOM * 100)}
                value={inputZoom}
                placeholder="100"
                autoFocus
                className="w-full"
                suffix={<span className="text-[13px] text-muted-foreground">%</span>}
                onChange={(v) => { if (v != null) setInputZoom(v); }}
                onPressEnter={() => handleZoomInput(inputZoom)}
              />
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => zoomIn()}><ZoomInOutlined />{t("canvas.zoom.in")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => zoomOut()}><ZoomOutOutlined />{t("canvas.zoom.out")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => fitView({ duration: 300 })}><ExpandOutlined />{t("canvas.fit")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => handleZoomTo(50)}>{t("canvas.zoom.to50")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => handleZoomTo(100)}>{t("canvas.zoom.to100")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Card>
    </>
  );
}
