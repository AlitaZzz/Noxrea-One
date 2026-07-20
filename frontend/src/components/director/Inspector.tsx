"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Button, ColorPicker, Tooltip, Select, Slider, Input, InputNumber } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import { useDirectorStore } from "@/stores/director-store";
import { POSE_PRESETS } from "@/director/entities/posePresets";
import { renderCameraThumbnail } from "@/director/util/cameraPreview";
import PoseSliders from "./PoseSliders";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const FOV_TIP = "控制镜头视野范围。数值越小，画面越近、越聚焦；数值越大，画面越广、能看到更多环境。";

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

function CameraAttr({ entity, ent, entities, runtime }: any) {
  const [previewUrl, setPreviewUrl] = useState("");
  const refreshPreview = useCallback(() => {
    if (!ent.cam) return;
    try { setPreviewUrl(renderCameraThumbnail((runtime as any)._getStage?.(), ent.cam, 248, 140)); } catch {}
  }, [ent.cam, runtime]);
  useEffect(() => { refreshPreview(); const id = setInterval(refreshPreview, 2000); return () => clearInterval(id); }, [refreshPreview]);

  return (
    <div className="flex-1 overflow-auto px-4 pb-3">
      <div className="dir-cam-preview">
        {previewUrl ? <img src={previewUrl} className="w-full h-full object-cover" alt="POV" /> : <div className="text-[10px] text-white/20 text-center pt-12">POV</div>}
        <div className="dir-cam-badge">FOV {Math.round(ent.cam?.fov || 40)}°</div>
      </div>
      <div className="dir-field">
        <label className="dir-label">名称</label>
        <div className="dir-namefld">
          <Input variant="borderless" size="small" className="dir-nameinp" value={ent.name} onChange={(e) => runtime.rename?.(entity.id, e.target.value)} />
        </div>
      </div>
      {entities.filter((e: any) => e.type === "camera").length > 1 && (
        <div className="dir-field">
          <label className="dir-label">切换机位</label>
          <Select size="small" className="w-full" value={entity.id}
            options={entities.filter((e: any) => e.type === "camera").map((c: any) => ({ value: c.id, label: c.name }))}
            onChange={(id: string) => runtime.select(id)} />
        </div>
      )}
      <TripleRow label="位置" step={0.01} keys={["x","y","z"].map((k) => ({ k, get: () => ent.root.position[k], set: (v: number) => { ent.root.position[k] = v; ent.update?.(); } }))} />
      <div className="dir-field">
        <div className="flex justify-between items-center dir-label"><span>视野角度 <Tooltip title={FOV_TIP}><span className="text-white/25 cursor-help">ⓘ</span></Tooltip></span><span className="dir-val">{Math.round(ent.cam?.fov || 40)}°</span></div>
        <div className="flex items-center gap-3">
          <Slider min={20} max={90} step={1} style={{ flex: 1, margin: 0 }} value={ent.cam?.fov || 40} tooltip={{ formatter: (v) => `${v}°` }}
            onChange={(v) => { ent.setFov?.(v as number); refreshPreview(); }} />
          <div className="dir-valbox">{Math.round(ent.cam?.fov || 40)}°</div>
        </div>
      </div>
    </div>
  );
}

export default function Inspector() {
  const runtime = useDirectorStore((s) => s.runtime);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const entities = useDirectorStore((s) => s.entities);
  const entity = entities.find((e) => e.id === selectedId) || null;
  const [activeTab, setActiveTab] = useState("attr");
  const [posePresetKey, setPosePresetKey] = useState<string | null>(null);
  const poseSyncRef = useRef<(() => void) | null>(null);
  const [, forceUpdate] = useState(0);
  const [entityColor, setEntityColor] = useState("");
  const syncFromObject = useCallback(() => forceUpdate((n) => n + 1), []);

  useEffect(() => { if (runtime) (runtime as any)._syncInspector = syncFromObject; return () => { if (runtime) (runtime as any)._syncInspector = null; }; }, [runtime, syncFromObject]);
  if (!entity || !runtime) return <div className="px-4 py-3 text-white/30 text-sm">未选中实体</div>;
  const ent = (runtime as any)._getEntity?.(entity.id) || null;
  if (!ent) return <div className="px-4 py-3 text-white/30 text-sm">加载中...</div>;

  const isCharacter = ent.type === "character", isCamera = ent.type === "camera", isCrowd = ent.type === "crowd";
  const typeLabel = isCharacter ? "角色" : isCamera ? "摄像机" : isCrowd ? "群众" : "道具";
  const tabItems = [{ key: "attr", label: "属性" }, ...(isCharacter || isCrowd ? [{ key: "pose", label: "姿势" }] : [])];
  const colorFromEntity = `#${(ent.color || 0x34c759).toString(16).padStart(6, "0")}`;
  useEffect(() => { setEntityColor(colorFromEntity); }, [colorFromEntity]);

  return (
    <div className="flex flex-col h-full text-sm">
      <div className="dir-rp-pad">
        <div className="flex items-center justify-between mb-1">
          <div><span className="text-[10px] text-white/35">{typeLabel}</span><h3 className="text-sm font-medium text-white/80 truncate">{entity.name}</h3></div>
          <Tooltip title="删除"><Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => runtime.remove(entity.id)} /></Tooltip>
        </div>
      </div>
      <div className="dir-ptabs">
        {tabItems.map((t) => (
          <button key={t.key} type="button" onClick={() => setActiveTab(t.key)}
            className={`dir-ptab ${activeTab === t.key ? "on" : ""}`}>{t.label}</button>
        ))}
      </div>

      {activeTab === "attr" && !isCamera && (isCrowd ? (
        <div className="flex-1 overflow-auto p-4 space-y-2">
          <div className="dir-multi-note">已选中 {ent.members?.length || 0} 个角色，修改将同步应用到全部选中对象</div>
          <Button size="small" type="text" onClick={() => (runtime as any).ungroupCrowd?.(entity.id)}>⊟ 解组（拆为独立角色）</Button>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 pb-3">
          <div className="dir-field">
            <label className="dir-label">名称</label>
            <div className="dir-namefld">
              <Input variant="borderless" size="small" className="dir-nameinp" value={ent.name} onChange={(e) => runtime.rename?.(entity.id, e.target.value)} />
            </div>
          </div>
          <TripleRow label="位置" step={0.01} keys={["x","y","z"].map((k) => ({ k, get: () => ent.root.position[k], set: (v: number) => { ent.root.position[k] = v; } }))} />
          <TripleRow label="旋转" step={1} deg keys={["x","y","z"].map((k) => ({ k, get: () => ent.root.rotation[k] * R2D, set: (v: number) => { ent.root.rotation[k] = v * D2R; } }))} />
          <TripleRow label="缩放" step={0.01} keys={["x","y","z"].map((k) => ({ k, get: () => ent.root.scale[k], set: (v: number) => { ent.root.scale[k] = Math.max(0.05, v); } }))} />
          <div className="dir-field">
            <label className="dir-label">统一缩放</label>
            <div className="flex items-center gap-3">
              <Slider min={0.2} max={3} step={0.01} style={{ flex: 1, margin: 0 }}
                value={ent.baseScale ? ent.root.scale.y / ent.baseScale : 1}
                tooltip={{ formatter: (v) => (v as number).toFixed(1) }}
                onChange={(v) => { const girth = ent._girth || 1; const s = (ent.baseScale || 1) * (v as number); ent.root.scale.set(s * girth, s, s * girth); syncFromObject(); }} />
              <div className="dir-valbox">{(ent.baseScale ? ent.root.scale.y / ent.baseScale : 1).toFixed(1)}</div>
            </div>
          </div>
          <div className="dir-field">
            <label className="dir-label">颜色</label>
            <ColorPicker size="small" value={entityColor}
              onChange={(_, hex) => { (runtime as any).setEntityColor?.(entity.id, hex); setEntityColor(hex); }} />
          </div>
          <div className="flex items-center justify-between text-xs dir-dim">
            <span>可见</span>
            <span className="dir-eye" onClick={() => (runtime as any).toggleVisible?.(entity.id)}
              dangerouslySetInnerHTML={{ __html: entity.visible
                ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`
                : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.8M6.1 6.1C3.5 7.7 2 12 2 12s3.5 7 10 7a9.5 9.5 0 0 0 4-0.9M3 3l18 18"/></svg>` }} />
          </div>
        </div>
      ))}

      {activeTab === "attr" && isCamera && <CameraAttr entity={entity} ent={ent} entities={entities} runtime={runtime} />}

      {activeTab === "pose" && (isCharacter || isCrowd) && (
        <div className="flex-1 overflow-auto px-4 pb-3">
          {isCrowd && <div className="dir-multi-note mb-3">已选中 {ent.members?.length || 0} 个角色，修改将同步应用到全部选中对象</div>}
          <div className="dir-sec-title">姿势预设</div>
          <div className="dir-pose-grid">
            {POSE_PRESETS.map((p) => (
              <button key={p.key} className={`dir-posebtn ${posePresetKey === p.key ? "on" : ""}`}
                onClick={() => { isCrowd ? (runtime as any)._broadcastPosePreset?.(entity.id, p.key) : runtime.applyPosePreset(entity.id, p.key); setPosePresetKey(p.key); poseSyncRef.current?.(); }}>{p.label}</button>
            ))}
          </div>
          <button className="dir-minibtn" onClick={() => { isCrowd ? (runtime as any)._broadcastResetPose?.(entity.id) : ent.resetPose?.(); setPosePresetKey(null); poseSyncRef.current?.(); }}>⟲ 复位姿势</button>
          <div className="dir-sec-title">姿势调节</div>
          {isCrowd ? (
            <PoseSliders characterId={entity.id} values={ent.members?.[0]?.values || {}} syncRef={poseSyncRef}
              onChange={(key, v) => { setPosePresetKey(null); const rep = ent.members?.[0]; if (rep) { rep.values[key] = v; rep.enterManual(); rep.currentPreset = null; rep.applyPose(); ent.members?.forEach?.((m: any) => { if (m !== rep) { Object.assign(m.values, rep.values); m.currentPreset = null; m.enterManual(); m.applyPose(); } }); } }} />
          ) : (
            <PoseSliders characterId={entity.id} values={ent.values || {}} syncRef={poseSyncRef}
              onChange={(key, v) => { setPosePresetKey(null); runtime.setJointValue(entity.id, key, v); }} />
          )}
        </div>
      )}
    </div>
  );
}
