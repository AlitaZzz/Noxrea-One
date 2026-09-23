/**
 * 3D 导演台右侧属性检视器。
 * 按选中实体类型渲染对应属性：通用变换（位移 / 旋转 / 缩放）、
 * 角色体型与姿态（内嵌 PoseSliders）、群组参数、相机焦距与预览出图等。
 */
"use client";

import { DeleteOutlined } from "@ant-design/icons";
import { Button, ColorPicker, Input, InputNumber,Select, Slider, Tooltip } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as THREE from "three";

import { DirExpandIcon } from "@/components/ui/icons/director/DirExpandIcon";
import { DirEyeIcon } from "@/components/ui/icons/director/DirEyeIcon";
import { DirEyeOffIcon } from "@/components/ui/icons/director/DirEyeOffIcon";
import { DirSendIcon } from "@/components/ui/icons/director/DirSendIcon";
import { DirTrashIcon } from "@/components/ui/icons/director/DirTrashIcon";
import { DirectorRuntime, useDirectorStore } from "@/features/director/director-store";
import { CameraEntity } from "@/features/director/entities/camera";
import { Character } from "@/features/director/entities/character";
import { Crowd } from "@/features/director/entities/crowd";
import { POSE_PRESETS } from "@/features/director/entities/pose-presets";
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
    <div className="dir-field">
      <label className="dir-label">{label}</label>
      <div className="flex gap-2">
        {keys.map(({ k, get, set, step: ks }) => (
          <div key={k} className="dir-fld flex-1">
            <span className="dir-ax">{k.toUpperCase()}</span>
            <InputNumber size="small" className="dir-inputnum flex-1" controls={false}
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
      <div className="dir-cam-preview">
        {previewUrl ? <img src={previewUrl} className="w-full h-full object-cover" alt="POV" /> : <div className="text-[10px] text-white/20 text-center pt-12">POV</div>}
        <div className="dir-cam-badge">FOV {Math.round(ent.cam?.fov || 40)}°</div>
        {/* 原生 title 换成系统 Tooltip */}
        <Tooltip title={t("director.fullscreenExpand")}>
        <button className="dir-cam-expand" onClick={() => {
          const stage = runtime._getStage();
          if (!stage) return;
          const url = renderCameraThumbnail(stage, ent.cam, 1280, 720, {
            before: () => runtime._beginCleanRender(),
            after: () => runtime._endCleanRender(),
          });
          setModalUrl(url);
        }}>⤢</button>
        </Tooltip>
      </div>
      <div className="dir-field">
        <label className="dir-label">{t("common.name")}</label>
        <div className="dir-namefld">
          <Input variant="borderless" size="small" className="dir-nameinp" value={ent.name} onChange={(e) => runtime.rename(entity.id, e.target.value)} />
        </div>
      </div>
      {entities.filter((e) => e.type === "camera").length > 1 && (
        <div className="dir-field">
          <label className="dir-label">{t("director.switchCamera")}</label>
          <Select size="small" className="w-full dir-select" value={entity.id}
            options={entities.filter((e) => e.type === "camera").map((c) => ({ value: c.id, label: c.name }))}
            onChange={(id: string) => runtime.select(id)} />
        </div>
      )}
      <TripleRow label={t("director.position")} step={0.01} keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.root.position[k], set: (v: number) => { ent.root.position[k] = v; ent.update(); refreshPreview(); } }))} />
      <div className="dir-field">
        <label className="dir-label">{t("director.aimTarget")}</label>
        <Select size="small" className="w-full dir-select" value={aimMode}
          options={aimOpts}
          onChange={(val) => {
            setAimMode(val);
            if (val !== "manual") {
              const target = runtime._getEntity(val);
              if (target?.root) {
                const box = worldBox(target.root, { useBones: target.type === "character" });
                const center = box.isEmpty() ? target.root.getWorldPosition(new THREE.Vector3()) : box.getCenter(new THREE.Vector3());
                ent.aimAt(center);
                schedulePreview();
              }
            }
          }} />
      </div>
      <TripleRow label={t("director.aimCoords")} step={0.05} keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.lookTarget[k], set: (v: number) => { ent.lookTarget[k] = v; ent.aimAt(ent.lookTarget); refreshPreview(); } }))} />
      <div className="dir-field">
        <div className="flex justify-between items-center dir-label"><span>{t("director.fovAngle")} <Tooltip title={t("director.fovTip")}><span className="text-white/25 cursor-help">ⓘ</span></Tooltip></span><span className="dir-val">{Math.round(ent.cam?.fov || 40)}°</span></div>
        <div className="flex items-center gap-3">
          <Slider min={20} max={90} step={1} style={{ flex: 1, margin: 0 }} value={ent.cam?.fov || 40} tooltip={{ formatter: (v) => `${v}°` }}
            onChange={(v) => { ent.setFov(v); refreshPreview(); }} />
          <div className="dir-valbox">{Math.round(ent.cam?.fov || 40)}°</div>
        </div>
      </div>
      {/* 全屏预览 modal */}
      {modalUrl && (
        <div className="dir-modal-overlay" onClick={() => setModalUrl("")}>
          <div className="dir-modal-box" onClick={(e) => e.stopPropagation()}>
            <button className="dir-modal-close" onClick={() => setModalUrl("")}>×</button>
            <img src={modalUrl} className="dir-modal-img" alt="POV" />
            <div className="dir-modal-bar">
              <span className="dir-modal-title">{t("director.fovModalTitle", { name: ent.name, fov: Math.round(ent.cam?.fov || 40) })}</span>
            </div>
          </div>
        </div>
      )}
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
    <div className="dir-field" style={{ marginTop: 8 }}>
      <div className="dir-sec-title" style={{ marginBottom: 8 }}>{t("director.cameraShots", { count: shots.length })}</div>
      {shots.length === 0 ? (
        <div className="dir-placeholder" style={{ marginBottom: 0 }}>{t("director.captureHint")}</div>
      ) : (
        <div className="dir-shot-grid">
          {shots.map((shot) => (
            // 卡片名可能被 CSS 截断，tooltip 展示完整名称；操作按钮改用系统 Tooltip
            <Tooltip key={shot.id} title={shot.name}>
              <div
                className="dir-shot-card"
                data-selected={shot.selected || undefined}
                onClick={() => toggleShotSelected(shot.id)}
              >
                <img src={shot.url + "?w=320"} alt={shot.name} loading="lazy" />
                <span className="dir-shot-label">{shot.name}</span>
                <div className="dir-shot-actions">
                  <Tooltip title={t("director.sendToCanvasTip")}>
                    <button onClick={(e) => { e.stopPropagation(); runtime?.sendShotToCanvas(shot.id); }}>
                      <DirSendIcon style={{ width: 14, height: 14 }} />
                    </button>
                  </Tooltip>
                  <Tooltip title={t("common.delete")}>
                    <button onClick={(e) => { e.stopPropagation(); removeShot(shot.id); }}>
                      <DirTrashIcon style={{ width: 14, height: 14 }} />
                    </button>
                  </Tooltip>
                  <Tooltip title={t("director.enlargePreview")}>
                    <button onClick={(e) => { e.stopPropagation(); setPreviewUrl(shot.url); }}>
                      <DirExpandIcon style={{ width: 14, height: 14 }} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            </Tooltip>
          ))}
        </div>
      )}
      {/* 放大预览 modal（复用相机预览弹层样式） */}
      {previewUrl && (
        <div className="dir-modal-overlay" onClick={() => setPreviewUrl("")}>
          <div className="dir-modal-box" onClick={(e) => e.stopPropagation()}>
            <button className="dir-modal-close" onClick={() => setPreviewUrl("")}>×</button>
            <img src={previewUrl} className="dir-modal-img" alt={t("director.preview")} />
          </div>
        </div>
      )}
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
    ? "#" + (((entity ? runtime._getEntity(entity.id) : null) as { color?: number } | null)?.color || 0x34c759).toString(16).padStart(6, "0")
    : "#34c759";
  const [prevColorKey, setPrevColorKey] = useState<string | null>(null);
  if (colorKey !== prevColorKey) {
    setPrevColorKey(colorKey);
    setEntityColor(colorKey);
  }
  if (!entity || !runtime) return <div className="px-4 py-3 text-white/30 text-sm">{t("director.noEntity")}</div>;
  const ent = runtime._getEntity(entity.id) || null;
  if (!ent) return <div className="px-4 py-3 text-white/30 text-sm">{t("director.loading")}</div>;

  const isCharacter = ent.type === "character", isCamera = ent.type === "camera", isCrowd = ent.type === "crowd";
  const typeLabel = isCharacter ? t("director.type.character") : isCamera ? t("director.type.camera") : isCrowd ? t("director.type.crowd") : t("director.type.prop");
  const tabItems = [{ key: "attr", label: t("director.tabAttr") }, ...(isCharacter || isCrowd ? [{ key: "pose", label: t("director.tabPose") }] : [])];
  const entBaseScale = (ent as { baseScale?: number }).baseScale;

  return (
    <div className="flex flex-col h-full text-sm">
      <div className="dir-rp-pad">
        <div className="flex items-center justify-between mb-1">
          <div><span className="text-[10px] text-white/35">{typeLabel}</span><h3 className="text-sm font-medium text-white/80 truncate">{entity.name}</h3></div>
          <Tooltip title={t("common.delete")}><Button type="text" size="small" icon={<DeleteOutlined />} style={{ color: "var(--dir-dim)" }} onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.color = "var(--dir-txt)"} onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.color = "var(--dir-dim)"} onClick={() => runtime.remove(entity.id)} /></Tooltip>
        </div>
      </div>
      <div className="dir-ptabs">
        {tabItems.map((t) => (
          <button key={t.key} type="button" onClick={() => setActiveTab(t.key)}
            className={`dir-ptab ${activeTab === t.key ? "on" : ""}`}>{t.label}</button>
        ))}
      </div>

      {activeTab === "attr" && !isCamera && (isCrowd ? (
        <div className="flex-1 overflow-auto px-4 pb-3">
          <div className="dir-multi-note">{t("director.multiSelectNote", { count: (ent as Crowd).members?.length || 0 })}</div>
          <button className="dir-minibtn" onClick={() => runtime.ungroupCrowd(entity.id)}>⊟ {t("director.ungroupDetail")}</button>
          <div className="dir-field">
            <label className="dir-label">{t("common.name")}</label>
            <div className="dir-namefld">
              <Input variant="borderless" size="small" className="dir-nameinp" value={ent.name} onChange={(e) => runtime.rename?.(entity.id, e.target.value)} />
            </div>
          </div>
          <TripleRow label={t("director.position")} step={0.01} keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.root.position[k], set: (v: number) => { ent.root.position[k] = v; } }))} />
          <TripleRow label={t("director.rotation")} step={1} deg keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.root.rotation[k] * R2D, set: (v: number) => { ent.root.rotation[k] = v * D2R; } }))} />
          <TripleRow label={t("director.scale")} step={0.01} keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.root.scale[k], set: (v: number) => { ent.root.scale[k] = Math.max(0.05, v); } }))} />
          <div className="dir-field">
            <label className="dir-label">{t("director.uniformScale")}</label>
            <div className="flex items-center gap-3">
              <Slider min={0.2} max={3} step={0.01} style={{ flex: 1, margin: 0 }}
                value={entBaseScale ? ent.root.scale.y / entBaseScale : 1}
                tooltip={{ formatter: (v) => (v as number).toFixed(1) }}
                onChange={(v) => { const s = (entBaseScale || 1) * (v as number); ent.root.scale.set(s, s, s); bumpInspector(); }} />
              <div className="dir-valbox">{(entBaseScale ? ent.root.scale.y / entBaseScale : 1).toFixed(1)}</div>
            </div>
          </div>
          <div className="dir-field">
            <label className="dir-label">{t("director.color")}</label>
            <ColorPicker size="small" value={entityColor}
              onChange={(c) => { const hex = c.toHexString(); runtime.setEntityColor(entity.id, hex); setEntityColor(hex); }} />
          </div>
          <div className="flex items-center justify-between text-xs dir-dim">
            <span>{t("director.visible")}</span>
            <span className="dir-eye" onClick={() => runtime.toggleVisible(entity.id)}>
              {entity.visible ? <DirEyeIcon style={{ width: 16, height: 16 }} /> : <DirEyeOffIcon style={{ width: 16, height: 16 }} />}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 pb-3">
          <div className="dir-field">
            <label className="dir-label">{t("common.name")}</label>
            <div className="dir-namefld">
              <Input variant="borderless" size="small" className="dir-nameinp" value={ent.name} onChange={(e) => runtime.rename?.(entity.id, e.target.value)} />
            </div>
          </div>
          <TripleRow label={t("director.position")} step={0.01} keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.root.position[k], set: (v: number) => { ent.root.position[k] = v; } }))} />
          <TripleRow label={t("director.rotation")} step={1} deg keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.root.rotation[k] * R2D, set: (v: number) => { ent.root.rotation[k] = v * D2R; } }))} />
          <TripleRow label={t("director.scale")} step={0.01} keys={(["x","y","z"] as const).map((k) => ({ k, get: () => ent.root.scale[k], set: (v: number) => { ent.root.scale[k] = Math.max(0.05, v); } }))} />
          <div className="dir-field">
            <label className="dir-label">{t("director.uniformScale")}</label>
            <div className="flex items-center gap-3">
              <Slider min={0.2} max={3} step={0.01} style={{ flex: 1, margin: 0 }}
                value={entBaseScale ? ent.root.scale.y / entBaseScale : 1}
                tooltip={{ formatter: (v) => (v as number).toFixed(1) }}
                onChange={(v) => { const girth = (ent as { _girth?: number })._girth || 1; const s = (entBaseScale || 1) * (v as number); ent.root.scale.set(s * girth, s, s * girth); bumpInspector(); }} />
              <div className="dir-valbox">{(entBaseScale ? ent.root.scale.y / entBaseScale : 1).toFixed(1)}</div>
            </div>
          </div>
          <div className="dir-field">
            <label className="dir-label">{t("director.color")}</label>
            <ColorPicker size="small" value={entityColor}
              onChange={(c) => { const hex = c.toHexString(); runtime.setEntityColor(entity.id, hex); setEntityColor(hex); }} />
          </div>
          <div className="flex items-center justify-between text-xs dir-dim">
            <span>{t("director.visible")}</span>
            <span className="dir-eye" onClick={() => runtime.toggleVisible(entity.id)}>
              {entity.visible ? <DirEyeIcon style={{ width: 16, height: 16 }} /> : <DirEyeOffIcon style={{ width: 16, height: 16 }} />}
            </span>
          </div>
        </div>
      ))}

      {activeTab === "attr" && isCamera && (
        <div className="flex-1 overflow-auto px-4 pb-3">
          <CameraAttr entity={entity} ent={ent as CameraEntity} entities={entities} runtime={runtime} />
          <CameraShots cameraId={entity.id} />
        </div>
      )}

      {activeTab === "pose" && (isCharacter || isCrowd) && (
        <div className="flex-1 overflow-auto px-4 pb-3">
          {isCrowd && <div className="dir-multi-note mb-3">{t("director.multiSelectNote", { count: (ent as Crowd).members?.length || 0 })}</div>}
          <div className="dir-sec-title">{t("director.posePresets")}</div>
          <div className="dir-pose-grid">
            {POSE_PRESETS.map((p) => (
              <button key={p.key} className={`dir-posebtn ${posePresetKey === p.key ? "on" : ""}`}
                onClick={() => { isCrowd ? runtime._broadcastPosePreset(entity.id, p.key) : runtime.applyPosePreset(entity.id, p.key); setPosePresetKey(p.key); poseSyncRef.current?.(); }}>{t(`director.${p.label}`)}</button>
            ))}
          </div>
          <button className="dir-minibtn" onClick={() => { isCrowd ? runtime._broadcastResetPose(entity.id) : (ent instanceof Character ? ent.resetPose() : undefined); setPosePresetKey(null); poseSyncRef.current?.(); }}>⟲ {t("director.resetPose")}</button>
          <div className="dir-sec-title">{t("director.poseAdjust")}</div>
          {isCrowd ? (
            <PoseSliders characterId={entity.id} values={(ent as Crowd).members?.[0]?.values || {}} syncRef={poseSyncRef}
              onChange={(key, v) => { setPosePresetKey(null); (ent as Crowd).members?.forEach((m: DirectorEntityMeta) => runtime.setJointValue(m.id, key, v)); }} />
          ) : (
            <PoseSliders characterId={entity.id} values={(ent as Character).values || {}} syncRef={poseSyncRef}
              onChange={(key, v) => { setPosePresetKey(null); runtime.setJointValue(entity.id, key, v); }} />
          )}
        </div>
      )}
    </div>
  );
}
