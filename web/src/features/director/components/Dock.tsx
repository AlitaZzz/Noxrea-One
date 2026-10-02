/**
 * 3D 导演台底部工具坞。
 * 提供变换模式切换（选择 / 移动 / 旋转 / 缩放）、添加角色 / 道具 / 相机、
 * 镜头预设选择与出图渲染等操作入口。
 */

"use client";

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { DirCaretIcon } from "@/components/ui/AppIcon";
import { DirCubeIcon } from "@/components/ui/AppIcon";
import { DirExpandIcon } from "@/components/ui/AppIcon";
import { DirFrameIcon } from "@/components/ui/AppIcon";
import { DirGroupIcon } from "@/components/ui/AppIcon";
import { DirImageIcon } from "@/components/ui/AppIcon";
import { DirMoveIcon } from "@/components/ui/AppIcon";
import { DirPersonIcon } from "@/components/ui/AppIcon";
import { DirPointerIcon } from "@/components/ui/AppIcon";
import { DirRotateIcon } from "@/components/ui/AppIcon";
import { DirScaleIcon } from "@/components/ui/AppIcon";
import { DirShotIcon } from "@/components/ui/AppIcon";
import { DirUploadIcon } from "@/components/ui/AppIcon";
import { DirVideoIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { groupedPresets } from "@/features/director/core/camera-presets";
import { DirectorRuntime, useDirectorStore } from "@/features/director/director-store";

const IC_MAP = {
  pointer: DirPointerIcon,
  move: DirMoveIcon,
  rotate: DirRotateIcon,
  scale: DirScaleIcon,
  person: DirPersonIcon,
  cube: DirCubeIcon,
  video: DirVideoIcon,
  shot: DirShotIcon,
  expand: DirExpandIcon,
  frame: DirFrameIcon,
  chevron: DirCaretIcon,
  upload: DirUploadIcon,
  image: DirImageIcon,
  group: DirGroupIcon,
};
const S = (n: string) => {
  const C = IC_MAP[n as keyof typeof IC_MAP];
  return C ? <C /> : null;
};
const BODY_KEYS = ["standard", "tall", "small", "broad", "slim"] as const;
const GEO_KEYS = ["box", "cylinder", "sphere", "mannequin"] as const;
const RATIOS = [["auto","Auto"],["21:9","21:9"],["16:9","16:9"],["4:3","4:3"],["1:1","1:1"],["3:4","3:4"],["9:16","9:16"]];
const TF_ICON: Record<string,string> = {translate:"move",rotate:"rotate",scale:"scale"};
const cameraPresets = groupedPresets();

// 群众阵列表单
function CrowdForm({ runtime }: { runtime: DirectorRuntime }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [spacing, setSpacing] = useState(1.2);
  const MAX = 6;

  return (
    <div className="rounded-xl border border-[var(--dir-line2)] bg-[var(--dir-panel)] p-3">
      <div className="mb-2 text-xs text-[var(--dir-dim2)]">
        {t("director.crowdArrayInfo", { count: rows * cols })}
      </div>
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="text-[var(--dir-dim)]">{t("director.spacing")}</span>
        <NumberInput min={0.5} max={5} step={0.1} value={spacing}
          className="h-8 flex-1 border-transparent bg-[var(--dir-panel2)] text-[var(--dir-txt)]"
          onChange={(v) => { if (v != null) setSpacing(v); }} />
      </div>
      <div className="flex justify-center">
        <div
          className="inline-grid gap-px overflow-hidden rounded-[3px] bg-[var(--dir-line2)]"
          style={{ gridTemplateColumns: `repeat(${MAX}, 16px)` }}
        >
          {Array.from({ length: MAX * MAX }).map((_, i) => {
            const r = Math.floor(i / MAX) + 1;
            const c = (i % MAX) + 1;
            const active = r <= rows && c <= cols;
            return (
              <div key={i} className={`size-4 cursor-pointer ${active ? "bg-[var(--dir-txt)]" : "bg-[var(--dir-panel2)]"}`}
                onMouseEnter={() => { setRows(r); setCols(c); }}
                onClick={() => runtime?.addCrowd?.(r, c, spacing)} />
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function Dock() {
  const { t } = useTranslation();
  const { notification } = useAppFeedback();
  const runtime = useDirectorStore((s) => s.runtime);
  const transformMode = useDirectorStore((s) => s.transformMode);
  const ratio = useDirectorStore((s) => s.ratio);

  // 菜单 open 状态（click trigger）
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [panoMenuOpen, setPanoMenuOpen] = useState(false);
  const [camMenuOpen, setCamMenuOpen] = useState(false);
  const [ratioMenuOpen, setRatioMenuOpen] = useState(false);

  const handleShot = useCallback(async () => {
    const shot = await runtime?.captureShot();
    if (shot) {
      useDirectorStore.getState().addShot({
        id: "s" + Date.now() + "_" + Math.random().toString(36).slice(2, 8), url: shot.url, name: shot.name, cameraId: shot.cameraId, createdAt: Date.now(),
      });
      notification.success({ title: shot.name, placement: "bottomRight", duration: 5 });
    }
  }, [runtime, notification]);

  const dockBtn = (icon: string, title: string, onClick: () => void, active = false, hideTooltip = false) => (
    <Tooltip key={title} open={hideTooltip ? false : undefined}><TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          onClick={onClick}
          className="aria-pressed:bg-accent aria-pressed:text-foreground"
          aria-pressed={active}
        >{S(icon)}</Button>
      </TooltipTrigger><TooltipContent>{title}</TooltipContent></Tooltip>
  );

  const menuItem = (icon: string, label: string, onClick: () => void, checked = false, hasSub = false) => (
    <Button
      key={label}
      type="button"
      variant="ghost"
      onClick={onClick}
      className="h-auto w-full justify-start gap-[11px] rounded-lg px-3 py-[9px] text-left text-[13px] text-[var(--dir-txt)] hover:bg-[var(--accent)]"
    >
      {icon ? <span className="flex w-[20px] items-center justify-center text-[var(--dir-dim)]">{S(icon)}</span> : <span className="w-[20px]" />}
      <span className="flex-1">{label}</span>
      {hasSub && <span className="ml-auto text-[var(--dir-dim)]">{S("chevron")}</span>}
      {checked && <span className="ml-auto text-xs text-blue-500">✓</span>}
    </Button>
  );

  const menuContent = (children: React.ReactNode, minWidth = 200) => (
    <div className="flex flex-col gap-0.5 rounded-xl border border-[var(--dir-line2)] bg-popover p-1.5" style={{ minWidth }}>
      {children}
    </div>
  );

  const closeAddMenu = () => setAddMenuOpen(false);

  return (
    <div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-[var(--dir-line2)] bg-card px-3 py-2 shadow-[0_10px_34px_rgba(0,0,0,0.55)]">
      {/* 变换模式 */}
      {dockBtn(TF_ICON.translate, t("director.tool.move"), () => runtime?.setTransformMode("translate"), transformMode === "translate")}
      {dockBtn(TF_ICON.rotate, t("director.tool.rotate"), () => runtime?.setTransformMode("rotate"), transformMode === "rotate")}
      {dockBtn(TF_ICON.scale, t("director.tool.scale"), () => runtime?.setTransformMode("scale"), transformMode === "scale")}

      {/* 分隔 */}
      <span className="mx-1 h-[22px] w-px bg-[var(--dir-line2)]" />

      {/* 添加角色/模型 */}
      <Popover open={addMenuOpen} onOpenChange={setAddMenuOpen}>
        <PopoverTrigger asChild>
          <div>{dockBtn("person", t("director.addCharacter"), () => {}, false, addMenuOpen)}</div>
        </PopoverTrigger>
        <PopoverContent side="top" align="center" className="z-[1050] w-auto p-0 bg-transparent border-0">
          {menuContent(
            <>
              {BODY_KEYS.map((k) => menuItem("person", t(`director.body.${k}`), () => { runtime?.addCharacter(k); closeAddMenu(); }))}
              <div className="mx-1 my-1.5 h-px bg-[var(--dir-line2)]" />
              <HoverCard>
                <HoverCardTrigger asChild>
                  <div>{menuItem("group", t("director.crowd"), () => {}, false, true)}</div>
                </HoverCardTrigger>
                <HoverCardContent side="right" align="start" className="z-[1050] w-auto p-0 bg-transparent border-0">
                  <CrowdForm runtime={runtime as DirectorRuntime} />
                </HoverCardContent>
              </HoverCard>
              <div className="mx-1 my-1.5 h-px bg-[var(--dir-line2)]" />
              <HoverCard>
                <HoverCardTrigger asChild>
                  <div>{menuItem("cube", t("director.geometry"), () => {}, false, true)}</div>
                </HoverCardTrigger>
                <HoverCardContent side="right" align="start" className="z-[1050] w-auto p-0 bg-transparent border-0">
                  {menuContent(
                    <>{GEO_KEYS.map((k) => menuItem("cube", t(`director.prop.${k}`), () => { runtime?.addProp(k); closeAddMenu(); }))}</>, 150
                  )}
                </HoverCardContent>
              </HoverCard>
            </>
          )}
        </PopoverContent>
      </Popover>

      {/* 全景图 */}
      <Popover open={panoMenuOpen} onOpenChange={setPanoMenuOpen}>
        <PopoverTrigger asChild>
          <div>{dockBtn("image", t("director.panorama"), () => {}, false, panoMenuOpen)}</div>
        </PopoverTrigger>
        <PopoverContent side="top" align="center" className="z-[1050] w-auto p-0 bg-transparent border-0">
          {menuContent(
            <label className="flex cursor-pointer items-center gap-[11px] rounded-lg px-3 py-[9px] text-[13px] text-[var(--dir-txt)] hover:bg-[var(--accent)]">
              <span className="flex w-[20px] items-center justify-center text-[var(--dir-dim)]">{S("upload")}</span>
              <span className="flex-1">{t("director.localUpload")}</span>
              <input type="file" accept="image/*" className="hidden" />
            </label>, 160,
          )}
        </PopoverContent>
      </Popover>

      {/* 添加机位 */}
      <Popover open={camMenuOpen} onOpenChange={setCamMenuOpen}>
        <PopoverTrigger asChild>
          <div>{dockBtn("video", t("director.addCameraPreset"), () => {}, false, camMenuOpen)}</div>
        </PopoverTrigger>
        <PopoverContent side="top" align="center" className="z-[1050] w-auto p-0 bg-transparent border-0">
          {menuContent(
            cameraPresets.map((g) => (
              <div key={g.name}>
                <div className="px-3 pb-1 pt-2 text-xs tracking-[.4px] text-[var(--dir-dim2)]">{t(`director.${g.name}`)}</div>
                {g.items.map((p) => menuItem("video", t(`director.${p.label}`), () => { runtime?.addCamera?.(p.key); setCamMenuOpen(false); }, false))}
              </div>
            )), 184,
          )}
        </PopoverContent>
      </Popover>

      {/* 分隔 */}
      <span className="mx-1 h-[22px] w-px bg-[var(--dir-line2)]" />

      {/* 取景比例 */}
      <Popover open={ratioMenuOpen} onOpenChange={setRatioMenuOpen}>
        <PopoverTrigger asChild>
          <div>{dockBtn("frame", t("director.frameRatio"), () => {}, false, ratioMenuOpen)}</div>
        </PopoverTrigger>
        <PopoverContent side="top" align="center" className="z-[1050] w-auto p-0 bg-transparent border-0">
          {menuContent(
            RATIOS.map(([v, l]) => menuItem("", l, () => { runtime?.setRatio(v); setRatioMenuOpen(false); }, ratio === v)),
            150,
          )}
        </PopoverContent>
      </Popover>

      {/* 截图 */}
      {dockBtn("shot", t("director.screenshot"), handleShot, false)}

    </div>
  );
}
