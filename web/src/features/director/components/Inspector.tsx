/**
 * 3D 导演台右侧属性检视器。
 * 按选中实体类型渲染对应属性：通用变换（位移 / 旋转 / 缩放）、
 * 角色体型与姿态（内嵌 PoseSliders）、群组参数、相机焦距与预览出图等。
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as THREE from "three";

import { DeleteOutlined, RotateRightOutlined } from "@/components/ui/AppIcon";
import { DirExpandIcon } from "@/components/ui/AppIcon";
import { DirEyeIcon } from "@/components/ui/AppIcon";
import { DirEyeOffIcon } from "@/components/ui/AppIcon";
import { DirSendIcon } from "@/components/ui/AppIcon";
import { DirTrashIcon } from "@/components/ui/AppIcon";
import { UngroupIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ColorPicker } from "@/components/ui/color-picker";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DirectorRuntime, useDirectorStore } from "@/features/director/director-store";
import { CameraEntity } from "@/features/director/entities/camera";
import { Character } from "@/features/director/entities/character";
import { Crowd } from "@/features/director/entities/crowd";
import { POSE_PRESETS } from "@/features/director/entities/pose-presets";
import { DIRECTOR_CHARACTER_COLOR, DIRECTOR_CHARACTER_HEX } from "@/features/director/theme";
import type { DirectorEntityMeta } from "@/features/director/types";
import { renderCameraThumbnail } from "@/features/director/util/camera-preview";
import { worldBox } from "@/features/director/util/measure";

import PoseSliders from "./PoseSliders";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function TripleRow({ label, keys, step = 0.01, deg = false }: {
  label: string; keys: { k: string; get: () => number; set: (v: number) => void; step?: number }[];
  step?: number; deg?: boolean;
}) {
  const fmt = (v: number) => deg ? String(Math.round(v)) : v.toFixed(2);
  return (
    <div className="mb-4">
      <label className="mb-2 block select-none text-xs text-muted-foreground">{label}</label>
      <div className="flex gap-2">
        {keys.map(({ k, get, set, step: ks }) => (
          <div key={k} className="flex flex-1 items-center gap-1.5 rounded-md border border-transparent bg-muted px-2.5">
            <span className="select-none text-xs text-muted-foreground">{k.toUpperCase()}</span>
            <NumberInput className="h-7 flex-1 border-0 bg-transparent shadow-none" controls={false}
              step={ks ?? step} value={deg ? Math.round(get()) : parseFloat(fmt(get()))}
              onChange={(v) => v != null && set(v as number)} />
          </div>
        ))}
      </div>
    </div>
  );
}

interface CameraAttrProps {
  entity: DirectorEntityMeta;
  ent: CameraEntity;
  entities: DirectorEntityMeta[];
  runtime: DirectorRuntime;
}

function CameraAttr({ entity, ent, entities, runtime }: CameraAttrProps) {
  const { t } = useTranslation();
  const [previewUrl, setPreviewUrl] = useState("");
  const [modalUrl, setModalUrl] = useState("");
  const [aimMode, setAimMode] = useState("manual");
  const pendingRef = useRef(false);
  const refreshPreview = useCallback(() => {
    if (!ent.cam) return;
    const stage = runtime._getStage();
    if (!stage) return;
    try {
      const url = renderCameraThumbnail(stage, ent.cam, 248, 140, {
        before: () => runtime._beginCleanRender(),
        after: () => runtime._endCleanRender(),
      });
      setPreviewUrl(url);
    } catch {}
  }, [ent.cam, runtime]);
  // 防抖预览(原项目用 requestAnimationFrame)
  const schedulePreview = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    requestAnimationFrame(() => { pendingRef.current = false; refreshPreview(); });
  }, [refreshPreview]);
  useEffect(() => { schedulePreview(); }, [schedulePreview]);
  // 注册到 runtime，让 gizmo 拖拽也能触发预览刷新
  useEffect(() => {
    runtime._setCameraAttrChange(() => schedulePreview());
    return () => { runtime._setCameraAttrChange(null); };
  }, [runtime, schedulePreview]);

  const crowdMembers = entities.flatMap((e) => e._members || []);
  const targets = [...entities, ...crowdMembers].filter((e) => e.type === "character" || e.type === "prop");
  const aimOpts = [{ value: "manual", label: t("director.manualCoords") }, ...targets.map((t) => ({ value: t.id, label: t.name }))];

  return (
    <div>
      <Card className="relative mb-[15px] aspect-video overflow-hidden rounded-[10px] border-border bg-black p-0 shadow-none">
        {previewUrl ? <img src={previewUrl} className="w-full h-full object-cover" alt="POV" /> : <div className="text-[10px] text-white/20 text-center pt-12">POV</div>}
        <div className="absolute left-[7px] top-[7px] select-none rounded-md bg-black/60 px-2 py-[3px] text-xs tabular-nums text-white">
          FOV {Math.round(ent.cam?.fov || 40)}°
        </div>
        {/* 原生 title 换成系统 Tooltip */}
        <Tooltip><TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("director.fullscreenExpand")}
              className="absolute bottom-[7px] right-[7px] rounded-[7px] border border-white/25 bg-black/50 text-white hover:bg-black/75 hover:text-white"
              onClick={() => {
              const stage = runtime._getStage();
              if (!stage) return;
              const url = renderCameraThumbnail(stage, ent.cam, 1280, 720, {
                before: () => runtime._beginCleanRender(),
                after: () => runtime._endCleanRender(),
              });
              setModalUrl(url);
            }}
            >
              <DirExpandIcon />
            </Button>
          </TooltipTrigger><TooltipContent>{t("director.fullscreenExpand")}</TooltipContent></Tooltip>
      </Card>
      <div className="mb-4">
        <label className="mb-2 block select-none text-xs text-muted-foreground">{t("common.name")}</label>
        <div className="rounded-md bg-muted px-3">
          <Input className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" value={ent.name} onChange={(e) => runtime.rename(entity.id, e.target.value)} />
        </div>
      </div>
      {entities.filter((e) => e.type === "camera").length > 1 && (
        <div className="mb-4">
          <label className="mb-2 block select-none text-xs text-muted-foreground">{t("director.switchCamera")}</label>
          <Select value={entity.id} onValueChange={(id) => runtime.select(id)}>
            <SelectTrigger size="sm" className="h-8 w-full bg-muted text-foreground shadow-none"><SelectValue /></SelectTrigger>
            <SelectContent>
              {entities.filter((e) => e.type === "camera").map((camera) => <SelectItem key={camera.id} value={camera.id}>{camera.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      <TripleRow label={t("director.position")} step={0.01} keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.root.position[k], set: (v: number) => { ent.root.position[k] = v; ent.update(); runtime.requestRender(); refreshPreview(); } }))} />
      <div className="mb-4">
        <label className="mb-2 block select-none text-xs text-muted-foreground">{t("director.aimTarget")}</label>
        <Select value={aimMode} onValueChange={(val) => {
            setAimMode(val);
            if (val !== "manual") {
              const target = runtime._getEntity(val);
              if (target?.root) {
                const box = worldBox(target.root, { useBones: target.type === "character" });
                const center = box.isEmpty() ? target.root.getWorldPosition(new THREE.Vector3()) : box.getCenter(new THREE.Vector3());
                ent.aimAt(center);
                runtime.requestRender();
                schedulePreview();
              }
            }
          }}>
          <SelectTrigger size="sm" className="h-8 w-full bg-muted text-foreground shadow-none"><SelectValue /></SelectTrigger>
          <SelectContent>
            {aimOpts.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <TripleRow label={t("director.aimCoords")} step={0.05} keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.lookTarget[k], set: (v: number) => { ent.lookTarget[k] = v; ent.aimAt(ent.lookTarget); runtime.requestRender(); refreshPreview(); } }))} />
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground"><span>{t("director.fovAngle")} <Tooltip><TooltipTrigger asChild><span className="cursor-help text-muted-foreground">ⓘ</span></TooltipTrigger><TooltipContent>{t("director.fovTip")}</TooltipContent></Tooltip></span><span>{Math.round(ent.cam?.fov || 40)}°</span></div>
        <div className="flex items-center gap-3">
          <Slider min={20} max={90} step={1} className="flex-1" value={[ent.cam?.fov || 40]}
            onValueChange={([next]) => { ent.setFov(next); runtime.requestRender(); refreshPreview(); }} />
          <div className="min-w-14 rounded-md bg-muted px-2.5 py-1.5 text-center text-xs tabular-nums text-muted-foreground">{Math.round(ent.cam?.fov || 40)}°</div>
        </div>
      </div>
      <Dialog open={Boolean(modalUrl)} onOpenChange={(open) => { if (!open) setModalUrl(""); }}>
        <DialogContent className="w-auto max-w-[90vw] gap-3 p-3 sm:max-w-[90vw]">
          <img src={modalUrl} className="block max-h-[78vh] max-w-[86vw] rounded-lg" alt="POV" />
          <DialogTitle className="text-sm font-medium">
            {t("director.fovModalTitle", { name: ent.name, fov: Math.round(ent.cam?.fov || 40) })}
          </DialogTitle>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 相机截图缩略图面板 */
function CameraShots({ cameraId }: { cameraId: string }) {
  const { t } = useTranslation();
  const allShots = useDirectorStore((s) => s.shots);
  const toggleShotSelected = useDirectorStore((s) => s.toggleShotSelected);
  const removeShot = useDirectorStore((s) => s.removeShot);
  const runtime = useDirectorStore((s) => s.runtime);
  const [previewUrl, setPreviewUrl] = useState("");

  const shots = useMemo(() => {
    const seen = new Set<string>();
    return allShots.filter((s) => s.cameraId === cameraId && !seen.has(s.id) && seen.add(s.id));
  }, [allShots, cameraId]);

  return (
    <div className="mt-2 mb-4">
      <div className="mb-2 mt-1 text-sm font-semibold">{t("director.cameraShots", { count: shots.length })}</div>
      {shots.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{t("director.captureHint")}</div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {shots.map((shot) => (
            // 卡片名可能被 CSS 截断，tooltip 展示完整名称；操作按钮改用系统 Tooltip
            <Tooltip key={shot.id}><TooltipTrigger asChild>
                <Card className="group relative aspect-video overflow-hidden rounded-lg border-2 border-transparent bg-card p-0 shadow-none">
                  <Button
                    type="button"
                    variant="ghost"
                    aria-pressed={shot.selected}
                    className="absolute inset-0 z-0 h-full w-full rounded-lg border-2 border-transparent bg-card p-0 hover:bg-transparent hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 data-[selected]:border-ring data-[selected]:hover:border-ring"
                    data-selected={shot.selected || undefined}
                    onClick={() => toggleShotSelected(shot.id)}
                  >
                    <img src={shot.url + "?w=320"} alt={shot.name} loading="lazy" className="absolute inset-0 size-full object-cover" />
                    <span className="absolute inset-x-0 bottom-0 z-[1] truncate bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-3 text-left text-xs tabular-nums text-white">{shot.name}</span>
                  </Button>
                  <div className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center gap-1.5 bg-black/55 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                    <Tooltip><TooltipTrigger asChild>
                        <Button type="button" variant="ghost" size="icon-xs" aria-label={t("director.sendToCanvasTip")} className="bg-background/80 text-foreground hover:bg-background" onClick={(e) => { e.stopPropagation(); runtime?.sendShotToCanvas(shot.id); }}>
                          <DirSendIcon style={{ width: 14, height: 14 }} />
                        </Button>
                      </TooltipTrigger><TooltipContent>{t("director.sendToCanvasTip")}</TooltipContent></Tooltip>
                    <Tooltip><TooltipTrigger asChild>
                        <Button type="button" variant="ghost" size="icon-xs" aria-label={t("common.delete")} className="bg-background/80 text-foreground hover:bg-background" onClick={(e) => { e.stopPropagation(); removeShot(shot.id); }}>
                          <DirTrashIcon style={{ width: 14, height: 14 }} />
                        </Button>
                      </TooltipTrigger><TooltipContent>{t("common.delete")}</TooltipContent></Tooltip>
                    <Tooltip><TooltipTrigger asChild>
                        <Button type="button" variant="ghost" size="icon-xs" aria-label={t("director.enlargePreview")} className="bg-background/80 text-foreground hover:bg-background" onClick={(e) => { e.stopPropagation(); setPreviewUrl(shot.url); }}>
                          <DirExpandIcon style={{ width: 14, height: 14 }} />
                        </Button>
                      </TooltipTrigger><TooltipContent>{t("director.enlargePreview")}</TooltipContent></Tooltip>
                  </div>
                </Card>
              </TooltipTrigger><TooltipContent>{shot.name}</TooltipContent></Tooltip>
          ))}
        </div>
      )}
      <Dialog open={Boolean(previewUrl)} onOpenChange={(open) => { if (!open) setPreviewUrl(""); }}>
        <DialogContent className="w-auto max-w-[90vw] p-3 sm:max-w-[90vw]">
          <DialogTitle className="sr-only">{t("director.preview")}</DialogTitle>
          <img src={previewUrl} className="block max-h-[78vh] max-w-[86vw] rounded-lg" alt={t("director.preview")} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function Inspector() {
  const { t } = useTranslation();
  const runtime = useDirectorStore((s) => s.runtime);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const entities = useDirectorStore((s) => s.entities);
  const entity = entities.find((e) => e.id === selectedId)
    || entities.flatMap((e) => e._members || [])
        .find((m) => m.id === selectedId)
    || null;
  const [activeTab, setActiveTab] = useState("attr");
  const [posePresetKey, setPosePresetKey] = useState<string | null>(null);
  const poseSyncRef = useRef<(() => void) | null>(null);
  const [entityColor, setEntityColor] = useState("");
  // Three.js 实体属性是可变对象不进 store；gizmo 拖拽 / 统一缩放等外部变更
  // 通过 bumpInspector 递增 tick 触发重渲染，渲染期直读 ent.root 拿到的即最新值。
  // tick 值本身不参与渲染，仅订阅
  useDirectorStore((s) => s.inspectorTick);
  const bumpInspector = useCallback(() => useDirectorStore.getState().bumpInspector(), []);
  const [prevEntityId, setPrevEntityId] = useState(entity?.id);
  if (entity?.id !== prevEntityId) {
    setPrevEntityId(entity?.id);
    setActiveTab("attr");
  }
  const colorKey = runtime
    ? "#" + (((entity ? runtime._getEntity(entity.id) : null) as { color?: number } | null)?.color || DIRECTOR_CHARACTER_COLOR).toString(16).padStart(6, "0")
    : DIRECTOR_CHARACTER_HEX;
  const [prevColorKey, setPrevColorKey] = useState<string | null>(null);
  if (colorKey !== prevColorKey) {
    setPrevColorKey(colorKey);
    setEntityColor(colorKey);
  }
  if (!entity || !runtime) return <div className="px-4 py-3 text-sm text-muted-foreground">{t("director.noEntity")}</div>;
  const ent = runtime._getEntity(entity.id) || null;
  if (!ent) return <div className="px-4 py-3 text-sm text-muted-foreground">{t("director.loading")}</div>;

  const isCharacter = ent.type === "character", isCamera = ent.type === "camera", isCrowd = ent.type === "crowd";
  const typeLabel = isCharacter ? t("director.type.character") : isCamera ? t("director.type.camera") : isCrowd ? t("director.type.crowd") : t("director.type.prop");
  const tabItems = [{ key: "attr", label: t("director.tabAttr") }, ...(isCharacter || isCrowd ? [{ key: "pose", label: t("director.tabPose") }] : [])];
  const entBaseScale = (ent as { baseScale?: number }).baseScale;

  return (
    <div className="flex flex-col h-full text-sm">
      <div className="px-4 pb-0 pt-[18px]">
        <div className="flex items-center justify-between mb-1">
          <div><span className="text-[10px] text-muted-foreground">{typeLabel}</span><h3 className="truncate text-sm font-medium text-foreground">{entity.name}</h3></div>
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t("common.delete")} className="text-muted-foreground" onClick={() => runtime.remove(entity.id)} ><DeleteOutlined /></Button></TooltipTrigger><TooltipContent>{t("common.delete")}</TooltipContent></Tooltip>
        </div>
      </div>
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList variant="line" className="w-full shrink-0 justify-start gap-6 rounded-none border-b border-border px-4">
          {tabItems.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key} className="flex-none rounded-none px-0 py-3">
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

      <TabsContent value="attr" className="min-h-0 flex-1">
      {!isCamera && (isCrowd ? (
        <div className="flex-1 overflow-auto px-4 pb-3">
          <div className="mb-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{t("director.multiSelectNote", { count: (ent as Crowd).members?.length || 0 })}</div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="mb-3 w-full justify-center gap-1.5"
            onClick={() => runtime.ungroupCrowd(entity.id)}
          >
            <UngroupIcon className="size-4" />
            {t("director.ungroupDetail")}
          </Button>
          <div className="mb-4">
            <label className="mb-2 block select-none text-xs text-muted-foreground">{t("common.name")}</label>
            <div className="rounded-md bg-muted px-3">
            <Input className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" value={ent.name} onChange={(e) => runtime.rename?.(entity.id, e.target.value)} />
            </div>
          </div>
          <TripleRow label={t("director.position")} step={0.01} keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.root.position[k], set: (v: number) => { ent.root.position[k] = v; runtime.requestRender(); } }))} />
          <TripleRow label={t("director.rotation")} step={1} deg keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.root.rotation[k] * R2D, set: (v: number) => { ent.root.rotation[k] = v * D2R; runtime.requestRender(); } }))} />
          <TripleRow label={t("director.scale")} step={0.01} keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.root.scale[k], set: (v: number) => { ent.root.scale[k] = Math.max(0.05, v); runtime.requestRender(); } }))} />
          <div className="mb-4">
            <label className="mb-2 block select-none text-xs text-muted-foreground">{t("director.uniformScale")}</label>
            <div className="flex items-center gap-3">
              <Slider min={0.2} max={3} step={0.01} className="flex-1"
                value={[entBaseScale ? ent.root.scale.y / entBaseScale : 1]}
                onValueChange={([next]) => { const s = (entBaseScale || 1) * next; ent.root.scale.set(s, s, s); bumpInspector(); runtime.requestRender(); }} />
              <div className="min-w-14 rounded-md bg-muted px-2.5 py-1.5 text-center text-xs tabular-nums text-muted-foreground">{(entBaseScale ? ent.root.scale.y / entBaseScale : 1).toFixed(1)}</div>
            </div>
          </div>
          <div className="mb-4">
            <label className="mb-2 block select-none text-xs text-muted-foreground">{t("director.color")}</label>
            <ColorPicker size="sm" value={entityColor}
              onChange={(hex) => { runtime.setEntityColor(entity.id, hex); setEntityColor(hex); }} />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("director.visible")}</span>
            <Button variant="ghost" size="icon-xs" aria-label={t("director.visible")} onClick={() => runtime.toggleVisible(entity.id)}>
              {entity.visible ? <DirEyeIcon style={{ width: 16, height: 16 }} /> : <DirEyeOffIcon style={{ width: 16, height: 16 }} />}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 pb-3">
          <div className="mb-4">
            <label className="mb-2 block select-none text-xs text-muted-foreground">{t("common.name")}</label>
            <div className="rounded-md bg-muted px-3">
              <Input className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" value={ent.name} onChange={(e) => runtime.rename?.(entity.id, e.target.value)} />
            </div>
          </div>
          <TripleRow label={t("director.position")} step={0.01} keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.root.position[k], set: (v: number) => { ent.root.position[k] = v; runtime.requestRender(); } }))} />
          <TripleRow label={t("director.rotation")} step={1} deg keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.root.rotation[k] * R2D, set: (v: number) => { ent.root.rotation[k] = v * D2R; runtime.requestRender(); } }))} />
          <TripleRow label={t("director.scale")} step={0.01} keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.root.scale[k], set: (v: number) => { ent.root.scale[k] = Math.max(0.05, v); runtime.requestRender(); } }))} />
          <div className="mb-4">
            <label className="mb-2 block select-none text-xs text-muted-foreground">{t("director.uniformScale")}</label>
            <div className="flex items-center gap-3">
              <Slider min={0.2} max={3} step={0.01} className="flex-1"
                value={[entBaseScale ? ent.root.scale.y / entBaseScale : 1]}
                onValueChange={([next]) => { const girth = (ent as { _girth?: number })._girth || 1; const s = (entBaseScale || 1) * next; ent.root.scale.set(s * girth, s, s * girth); bumpInspector(); runtime.requestRender(); }} />
              <div className="min-w-14 rounded-md bg-muted px-2.5 py-1.5 text-center text-xs tabular-nums text-muted-foreground">{(entBaseScale ? ent.root.scale.y / entBaseScale : 1).toFixed(1)}</div>
            </div>
          </div>
          <div className="mb-4">
            <label className="mb-2 block select-none text-xs text-muted-foreground">{t("director.color")}</label>
            <ColorPicker size="sm" value={entityColor}
              onChange={(hex) => { runtime.setEntityColor(entity.id, hex); setEntityColor(hex); }} />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("director.visible")}</span>
            <Button variant="ghost" size="icon-xs" aria-label={t("director.visible")} onClick={() => runtime.toggleVisible(entity.id)}>
              {entity.visible ? <DirEyeIcon style={{ width: 16, height: 16 }} /> : <DirEyeOffIcon style={{ width: 16, height: 16 }} />}
            </Button>
          </div>
        </div>
      ))}

      {isCamera && (
        <div className="flex-1 overflow-auto px-4 pb-3">
          <CameraAttr entity={entity} ent={ent as CameraEntity} entities={entities} runtime={runtime} />
          <CameraShots cameraId={entity.id} />
        </div>
      )}
      </TabsContent>

      <TabsContent value="pose" className="min-h-0 flex-1">
      {(isCharacter || isCrowd) && (
        <div className="flex-1 overflow-auto px-4 pb-3">
          {isCrowd && <div className="mb-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{t("director.multiSelectNote", { count: (ent as Crowd).members?.length || 0 })}</div>}
          <div className="mb-3.5 mt-1 text-sm font-semibold">{t("director.posePresets")}</div>
          <div className="mb-1 grid grid-cols-4 gap-2">
            {POSE_PRESETS.map((p) => (
              <Button
                key={p.key}
                type="button"
                size="sm"
                variant={posePresetKey === p.key ? "secondary" : "outline"}
                aria-pressed={posePresetKey === p.key}
                className="h-auto min-h-8 w-full justify-center px-1.5 py-1.5 text-[13px]"
                onClick={() => {
                  if (isCrowd) runtime._broadcastPosePreset(entity.id, p.key);
                  else runtime.applyPosePreset(entity.id, p.key);
                  setPosePresetKey(p.key);
                  poseSyncRef.current?.();
                }}
              >
                {t(`director.${p.label}`)}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="mb-3 w-full justify-center gap-1.5"
            onClick={() => {
              if (isCrowd) runtime._broadcastResetPose(entity.id);
              else if (ent instanceof Character) {
                ent.resetPose();
                runtime.requestRender();
              }
              setPosePresetKey(null);
              poseSyncRef.current?.();
            }}
          >
            <RotateRightOutlined className="size-4" />
            {t("director.resetPose")}
          </Button>
          <div className="mb-3.5 mt-1 text-sm font-semibold">{t("director.poseAdjust")}</div>
          {isCrowd ? (
            <PoseSliders characterId={entity.id} values={(ent as Crowd).members?.[0]?.values || {}} syncRef={poseSyncRef}
              onChange={(key, v) => { setPosePresetKey(null); (ent as Crowd).members?.forEach((m: DirectorEntityMeta) => runtime.setJointValue(m.id, key, v)); }} />
          ) : (
            <PoseSliders characterId={entity.id} values={(ent as Character).values || {}} syncRef={poseSyncRef}
              onChange={(key, v) => { setPosePresetKey(null); runtime.setJointValue(entity.id, key, v); }} />
          )}
        </div>
      )}
      </TabsContent>
      </Tabs>
    </div>
  );
}
