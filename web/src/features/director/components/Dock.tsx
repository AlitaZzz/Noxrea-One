/**
 * 3D 导演台底部工具坞。
 * 提供变换模式切换（选择 / 移动 / 旋转 / 缩放）、添加角色 / 道具 / 相机、
 * 镜头预设选择与出图渲染等操作入口。
 */

"use client";

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { DirCubeIcon } from "@/components/ui/AppIcon";
import { DirFrameIcon } from "@/components/ui/AppIcon";
import { DirGroupIcon } from "@/components/ui/AppIcon";
import { DirImageIcon } from "@/components/ui/AppIcon";
import { DirMoveIcon } from "@/components/ui/AppIcon";
import { DirPersonIcon } from "@/components/ui/AppIcon";
import { DirRotateIcon } from "@/components/ui/AppIcon";
import { DirScaleIcon } from "@/components/ui/AppIcon";
import { DirShotIcon } from "@/components/ui/AppIcon";
import { DirUploadIcon } from "@/components/ui/AppIcon";
import { DirVideoIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NumberInput } from "@/components/ui/number-input";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { groupedPresets } from "@/features/director/core/camera-presets";
import { DirectorRuntime, useDirectorStore } from "@/features/director/director-store";

const IC_MAP = {
  move: DirMoveIcon,
  rotate: DirRotateIcon,
  scale: DirScaleIcon,
  person: DirPersonIcon,
  cube: DirCubeIcon,
  video: DirVideoIcon,
  shot: DirShotIcon,
  frame: DirFrameIcon,
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
    <Card className="w-[216px] gap-0 border-border bg-card p-0 shadow-sm">
      <CardContent className="p-3">
      <div className="mb-2 text-xs text-muted-foreground">
        {t("director.crowdArrayInfo", { count: rows * cols })}
      </div>
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t("director.spacing")}</span>
        <NumberInput min={0.5} max={5} step={0.1} value={spacing}
          className="h-8 flex-1"
          onChange={(v) => { if (v != null) setSpacing(v); }} />
      </div>
      <div className="flex justify-center">
        <div
          className="inline-grid gap-px overflow-hidden rounded-sm bg-border"
          style={{ gridTemplateColumns: `repeat(${MAX}, 16px)` }}
        >
          {Array.from({ length: MAX * MAX }).map((_, i) => {
            const r = Math.floor(i / MAX) + 1;
            const c = (i % MAX) + 1;
            const active = r <= rows && c <= cols;
            return (
              <Button
                key={i}
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`${r} x ${c}`}
                className={`size-4 min-w-4 rounded-none p-0 ${active ? "bg-foreground hover:bg-foreground/80" : "bg-muted hover:bg-muted/80"}`}
                onMouseEnter={() => { setRows(r); setCols(c); }}
                onClick={() => runtime?.addCrowd?.(r, c, spacing)}
              />
            );
          })}
        </div>
      </div>
      </CardContent>
    </Card>
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

  const dockBtn = (icon: string, title: string, onClick: () => void, active = false) => (
    <Tooltip key={title}><TooltipTrigger asChild>
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

  const menuTrigger = (icon: string, title: string, open: boolean) => (
    <Tooltip open={open ? false : undefined}><TooltipTrigger asChild>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-pressed={open}
          className="aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          {S(icon)}
        </Button>
      </DropdownMenuTrigger>
    </TooltipTrigger><TooltipContent>{title}</TooltipContent></Tooltip>
  );

  const closeAddMenu = () => setAddMenuOpen(false);

  return (
    <Card className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 flex-row items-center gap-1 rounded-2xl border-border bg-card px-3 py-2 shadow-lg">
      {/* 变换模式 */}
      {dockBtn(TF_ICON.translate, t("director.tool.move"), () => runtime?.setTransformMode("translate"), transformMode === "translate")}
      {dockBtn(TF_ICON.rotate, t("director.tool.rotate"), () => runtime?.setTransformMode("rotate"), transformMode === "rotate")}
      {dockBtn(TF_ICON.scale, t("director.tool.scale"), () => runtime?.setTransformMode("scale"), transformMode === "scale")}

      {/* 分隔 */}
      <Separator orientation="vertical" className="mx-1 h-[22px]" />

      {/* 添加角色/模型 */}
      <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
        {menuTrigger("person", t("director.addCharacter"), addMenuOpen)}
        <DropdownMenuContent side="top" align="center" className="w-52">
          {BODY_KEYS.map((k) => (
            <DropdownMenuItem key={k} onSelect={() => { runtime?.addCharacter(k); closeAddMenu(); }}>
              <span className="flex w-5 items-center justify-center text-muted-foreground">{S("person")}</span>
              <span>{t(`director.body.${k}`)}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="flex w-5 items-center justify-center text-muted-foreground">{S("group")}</span>
              <span>{t("director.crowd")}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-auto p-2">
              <CrowdForm runtime={runtime as DirectorRuntime} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="flex w-5 items-center justify-center text-muted-foreground">{S("cube")}</span>
              <span>{t("director.geometry")}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-40">
              {GEO_KEYS.map((k) => (
                <DropdownMenuItem key={k} onSelect={() => { runtime?.addProp(k); closeAddMenu(); }}>
                  <span className="flex w-5 items-center justify-center text-muted-foreground">{S("cube")}</span>
                  <span>{t(`director.prop.${k}`)}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 全景图 */}
      <DropdownMenu open={panoMenuOpen} onOpenChange={setPanoMenuOpen}>
        {menuTrigger("image", t("director.panorama"), panoMenuOpen)}
        <DropdownMenuContent side="top" align="center" className="w-40">
          <DropdownMenuItem asChild>
            <label>
              <span className="flex w-5 items-center justify-center text-muted-foreground">{S("upload")}</span>
              <span>{t("director.localUpload")}</span>
              <input type="file" accept="image/*" className="hidden" />
            </label>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 添加机位 */}
      <DropdownMenu open={camMenuOpen} onOpenChange={setCamMenuOpen}>
        {menuTrigger("video", t("director.addCameraPreset"), camMenuOpen)}
        <DropdownMenuContent side="top" align="center" className="w-48">
          {cameraPresets.map((g) => (
            <div key={g.name}>
              <DropdownMenuLabel>{t(`director.${g.name}`)}</DropdownMenuLabel>
              {g.items.map((p) => (
                <DropdownMenuItem key={p.key} onSelect={() => { runtime?.addCamera?.(p.key); setCamMenuOpen(false); }}>
                  <span className="flex w-5 items-center justify-center text-muted-foreground">{S("video")}</span>
                  <span>{t(`director.${p.label}`)}</span>
                </DropdownMenuItem>
              ))}
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 分隔 */}
      <Separator orientation="vertical" className="mx-1 h-[22px]" />

      {/* 取景比例 */}
      <DropdownMenu open={ratioMenuOpen} onOpenChange={setRatioMenuOpen}>
        {menuTrigger("frame", t("director.frameRatio"), ratioMenuOpen)}
        <DropdownMenuContent side="top" align="center" className="w-40">
          <DropdownMenuRadioGroup value={ratio} onValueChange={(value) => { runtime?.setRatio(value); setRatioMenuOpen(false); }}>
            {RATIOS.map(([value, label]) => (
              <DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 截图 */}
      {dockBtn("shot", t("director.screenshot"), handleShot, false)}

    </Card>
  );
}
