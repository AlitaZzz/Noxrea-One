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
const FOV_TIP = "控制镜头视野范围。数值越小,画面越近、越聚焦;数值越大,画面越广、能看到更多环境。";

// ── 共享 ──────────────────────────────────────────────
const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--dir-dim)", marginBottom: 8 };
const fieldStyle: React.CSSProperties = { marginBottom: 15 };
const fldStyle: React.CSSProperties = { background: "var(--dir-panel2)", border: "1px solid transparent", borderRadius: 8, padding: "0 10px" };
const fldInputStyle: React.CSSProperties = { width: "100%", background: "none", border: "none", outline: "none", fontSize: "12.5px", padding: "8px 0", color: "var(--dir-txt)" };

function TripleRow({ label, keys, step = 0.01, deg = false }: {
  label: string; keys: { k: string; get: () => number; set: (v: number) => void; step?: number }[];
  step?: number; deg?: boolean;
}) {
  const fmt = (v: number) => deg ? String(Math.round(v)) : v.toFixed(2);
  return (
    <div style={fieldStyle}>
      <label style={labelStyle}>{label}</label>
      <div style={{ display: "flex", gap: 8 }}>
        {keys.map(({ k, get, set, step: ks }) => (
          <div key={k} style={{ ...fldStyle, flex: 1, display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 12, color: "var(--dir-dim)" }}>{k.toUpperCase()}</span>
            <InputNumber size="small" controls={false} step={ks ?? step}
              className="dir-inputnum" style={{ fontSize: "12.5px", color: "var(--dir-txt)" }}
              value={deg ? Math.round(get()) : parseFloat(fmt(get()))}
              onChange={(v) => v != null && set(v as number)} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 摄像机 ────────────────────────────────────────────
function CameraAttr({ entity, ent, entities, runtime }: any) {
  const [previewUrl, setPreviewUrl] = useState("");
  const refreshPreview = useCallback(() => {
    if (!ent.cam) return;
    try { setPreviewUrl(renderCameraThumbnail((runtime as any)._getStage?.(), ent.cam, 248, 140)); } catch {}
  }, [ent.cam, runtime]);
  useEffect(() => { refreshPreview(); const id = setInterval(refreshPreview, 2000); return () => clearInterval(id); }, [refreshPreview]);

  return (
    <div className="flex-1 overflow-auto px-4 pb-3 space-y-2">
      <div className="relative bg-black rounded-xl overflow-hidden border" style={{ aspectRatio: "16/9", borderColor: "var(--dir-line2)" }}>
        {previewUrl ? <img src={previewUrl} className="w-full h-full object-cover" alt="POV" /> : <div className="text-[10px] text-white/20 text-center pt-12">POV</div>}
        <div className="absolute top-2 left-2 text-[11px] text-white bg-black/60 px-2 py-0.5 rounded-md" style={{ fontVariantNumeric: "tabular-nums" }}>FOV {Math.round(ent.cam?.fov || 40)}°</div>
      </div>
      <div style={fieldStyle}>
        <label style={labelStyle}>名称</label>
        <div className="rounded-lg px-3" style={{ background: "var(--dir-panel2)" }}>
          <input className="w-full bg-transparent border-none outline-none text-[13px] py-[9px]" style={{ color: "var(--dir-txt)" }}
            value={ent.name} onChange={(e) => runtime.rename?.(entity.id, e.target.value)} />
        </div>
      </div>
      {entities.filter((e: any) => e.type === "camera").length > 1 && (
        <div style={fieldStyle}>
          <label style={labelStyle}>切换机位</label>
          <Select size="small" className="w-full" value={entity.id}
            options={entities.filter((e: any) => e.type === "camera").map((c: any) => ({ value: c.id, label: c.name }))}
            onChange={(id: string) => runtime.select(id)} />
        </div>
      )}
      <TripleRow label="位置" step={0.01} keys={["x","y","z"].map((k) => ({ k, get: () => ent.root.position[k], set: (v: number) => { ent.root.position[k] = v; ent.update?.(); } }))} />
      <div style={fieldStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <label style={{ fontSize: 12, color: "var(--dir-dim)" }}>视野角度 <Tooltip title={FOV_TIP}><span className="text-white/25 cursor-help">ⓘ</span></Tooltip></label>
          <span style={{ fontSize: "12.5px", color: "var(--dir-dim2)" }}>{Math.round(ent.cam?.fov || 40)}°</span>
        </div>
        <div className="flex items-center gap-3">
          <Slider min={20} max={90} step={1} style={{ flex: 1, margin: 0 }} value={ent.cam?.fov || 40} tooltip={{ formatter: (v) => `${v}°` }}
            onChange={(v) => { ent.setFov?.(v as number); refreshPreview(); }} />
          <div className="dir-valbox">{Math.round(ent.cam?.fov || 40)}°</div>
        </div>
      </div>
    </div>
  );
}

// ── 主组件 ────────────────────────────────────────────
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

  // 实体变化时同步颜色到本地 state
  const colorFromEntity = `#${(ent.color || 0x34c759).toString(16).padStart(6, "0")}`;
  useEffect(() => { setEntityColor(colorFromEntity); }, [colorFromEntity]);

  const isCharacter = ent.type === "character";
  const isCamera = ent.type === "camera";
  const isCrowd = ent.type === "crowd";
  const typeLabel = isCharacter ? "角色" : isCamera ? "摄像机" : isCrowd ? "群众" : "道具";
  const tabItems = [{ key: "attr", label: "属性" }, ...(isCharacter || isCrowd ? [{ key: "pose", label: "姿势" }] : [])];

  return (
    <div className="flex flex-col h-full text-sm">
      <div style={{ padding: "18px 16px 0" }}>
        <div className="flex items-center justify-between mb-1">
          <div>
            <span className="text-[10px] text-white/35">{typeLabel}</span>
            <h3 className="text-sm font-medium text-white/80 truncate">{entity.name}</h3>
          </div>
          <Tooltip title="删除"><Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => runtime.remove(entity.id)} /></Tooltip>
        </div>
      </div>

      {/* ptabs */}
      <div className="flex gap-6 px-4 border-b" style={{ margin: "16px 0 18px", borderColor: "var(--dir-line)" }}>
        {tabItems.map((t) => (
          <button key={t.key} type="button" onClick={() => setActiveTab(t.key)}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, padding: "0 0 12px", position: "relative", color: activeTab === t.key ? "#fff" : "var(--dir-dim)" }}>
            {t.label}
            {activeTab === t.key && <span style={{ position: "absolute", left: 0, right: 0, bottom: -1, height: 2, background: "#fff", borderRadius: 2 }} />}
          </button>
        ))}
      </div>

      {/* 属性 Tab — 角色/道具 */}
      {activeTab === "attr" && !isCamera && (isCrowd ? (
        <div className="flex-1 overflow-auto px-4 pb-3 space-y-2">
          <div className="text-xs" style={{ color: "var(--dir-dim)", background: "var(--dir-panel2)", borderRadius: 8, padding: "9px 11px", margin: "12px 0 4px" }}>
            已选中 {ent.members?.length || 0} 个角色，修改将同步应用到全部选中对象
          </div>
          <Button size="small" type="text" onClick={() => (runtime as any).ungroupCrowd?.(entity.id)}>⊟ 解组（拆为独立角色）</Button>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 pb-3 space-y-1">
          <div style={fieldStyle}>
            <label style={labelStyle}>名称</label>
            <div className="rounded-lg px-3" style={{ background: "var(--dir-panel2)" }}>
              <Input variant="borderless" size="small" style={{ fontSize: 13, color: "var(--dir-txt)", padding: "9px 0" }}
                value={ent.name} onChange={(e) => runtime.rename?.(entity.id, e.target.value)} />
            </div>
          </div>
          <TripleRow label="位置" step={0.01} keys={["x","y","z"].map((k) => ({ k, get: () => ent.root.position[k], set: (v: number) => { ent.root.position[k] = v; } }))} />
          <TripleRow label="旋转" step={1} deg keys={["x","y","z"].map((k) => ({ k, get: () => ent.root.rotation[k] * R2D, set: (v: number) => { ent.root.rotation[k] = v * D2R; } }))} />
          <TripleRow label="缩放" step={0.01} keys={["x","y","z"].map((k) => ({ k, get: () => ent.root.scale[k], set: (v: number) => { ent.root.scale[k] = Math.max(0.05, v); } }))} />
          <div style={fieldStyle}>
            <label style={labelStyle}>统一缩放</label>
            <div className="flex items-center gap-3">
              <Slider min={0.2} max={3} step={0.01} style={{ flex: 1, margin: 0 }} value={ent.baseScale ? ent.root.scale.y / ent.baseScale : 1}
                tooltip={{ formatter: (v) => (v as number).toFixed(1) }}
                onChange={(v) => { const girth = ent._girth || 1; const s = (ent.baseScale || 1) * (v as number); ent.root.scale.set(s * girth, s, s * girth); syncFromObject(); }} />
              <div className="dir-valbox">{(ent.baseScale ? ent.root.scale.y / ent.baseScale : 1).toFixed(1)}</div>
            </div>
          </div>
          <div style={fieldStyle}>
            <label style={labelStyle}>颜色</label>
            <ColorPicker size="small" value={entityColor} showText disabledAlpha
              onChange={(_, hex) => {
                (runtime as any).setEntityColor?.(entity.id, hex);
                setEntityColor(hex);
              }} />
          </div>
          <div className="flex items-center justify-between text-xs" style={{ color: "var(--dir-dim)" }}>
            <span>可见</span>
            <span className="cursor-pointer opacity-60 hover:opacity-100" onClick={() => (runtime as any).toggleVisible?.(entity.id)}
              dangerouslySetInnerHTML={{ __html: entity.visible
                ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="white" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`
                : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="white" stroke-width="1.8"><path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.8M6.1 6.1C3.5 7.7 2 12 2 12s3.5 7 10 7a9.5 9.5 0 0 0 4-0.9M3 3l18 18"/></svg>` }} />
          </div>
        </div>
      ))}

      {/* 摄像机属性 */}
      {activeTab === "attr" && isCamera && <CameraAttr entity={entity} ent={ent} entities={entities} runtime={runtime} />}

      {/* 姿势 Tab */}
      {activeTab === "pose" && (isCharacter || isCrowd) && (
        <div className="flex-1 overflow-auto px-4 pb-3">
          {isCrowd && <div className="text-xs mb-3" style={{ color: "var(--dir-dim)", background: "var(--dir-panel2)", borderRadius: 8, padding: "9px 11px" }}>已选中 {ent.members?.length || 0} 个角色，修改将同步应用到全部选中对象</div>}
          <div style={{ fontSize: "13.5px", fontWeight: 600, marginBottom: 14, marginTop: 4 }}>姿势预设</div>
          <div className="grid grid-cols-4 gap-[7px] mb-4">
            {POSE_PRESETS.map((p) => (
              <button key={p.key}
                className={`dir-posebtn ${posePresetKey === p.key ? "on" : ""}`}
                onClick={() => {
                  if (isCrowd) (runtime as any)._broadcastPosePreset?.(entity.id, p.key);
                  else runtime.applyPosePreset(entity.id, p.key);
                  setPosePresetKey(p.key); poseSyncRef.current?.();
                }}>{p.label}</button>
            ))}
          </div>
          <button className="dir-minibtn" onClick={() => {
            if (isCrowd) (runtime as any)._broadcastResetPose?.(entity.id);
            else ent.resetPose?.();
            setPosePresetKey(null); poseSyncRef.current?.();
          }}>⟲ 复位姿势</button>
          <div style={{ fontSize: "13.5px", fontWeight: 600, marginTop: 16, marginBottom: 14 }}>姿势调节</div>
          {isCrowd ? (
            <PoseSliders characterId={entity.id}
              values={ent.members?.[0]?.values || {}}
              syncRef={poseSyncRef}
              onChange={(key, v) => {
                setPosePresetKey(null);
                const rep = ent.members?.[0];
                if (rep) {
                  rep.values[key] = v; rep.enterManual(); rep.currentPreset = null; rep.applyPose();
                  ent.members?.forEach?.((m: any) => {
                    if (m !== rep) { Object.assign(m.values, rep.values); m.currentPreset = null; m.enterManual(); m.applyPose(); }
                  });
                }
              }} />
          ) : (
            <PoseSliders characterId={entity.id} values={ent.values || {}} syncRef={poseSyncRef}
              onChange={(key, v) => { setPosePresetKey(null); runtime.setJointValue(entity.id, key, v); }} />
          )}
        </div>
      )}
    </div>
  );
}
