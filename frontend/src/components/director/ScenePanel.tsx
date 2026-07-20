"use client";

import { Switch, ColorPicker, Slider, InputNumber } from "antd";
import { useDirectorStore } from "@/stores/director-store";

function SliderRow({ label, min, max, step = 1, value, disabled, format, onChange }: {
  label?: string; min: number; max: number; step?: number;
  value: number; disabled?: boolean; format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginBottom: 15 }}>
      {label && <label style={{ display: "block", fontSize: 12, color: "var(--dir-dim)", marginBottom: 8 }}>{label}</label>}
      <div className="flex items-center gap-3">
        <Slider min={min} max={max} step={step} value={value} disabled={disabled}
          style={{ flex: 1, margin: 0 }}
          tooltip={{ formatter: (v) => format ? format(v as number) : String(v) }}
          onChange={(v) => onChange(v as number)} />
        <div className="dir-valbox">{format ? format(value) : value}</div>
      </div>
    </div>
  );
}

// 开行:iOS风格开关
function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span style={{ fontSize: "13.5px", fontWeight: 600 }}>{label}</span>
      <Switch size="small" checked={checked} onChange={onChange} className="dir-switch" />
    </div>
  );
}

export default function ScenePanel() {
  const runtime = useDirectorStore((s) => s.runtime);
  const sceneState = useDirectorStore((s) => s.sceneState);

  return (
    <div style={{ padding: "18px 16px" }} className="text-white/70 text-sm overflow-auto">
      <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>3D场景</h2>

      {/* Section 1: 场景缩放 + 天空 */}
      <div style={{ marginTop: 14 }}>
        <SliderRow label="场景缩放" min={0.1} max={3} step={0.05}
          value={sceneState.scale}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => runtime?.setSceneScale(v)} />

        {/* 场景平移 XYZ */}
        <div style={{ marginBottom: 15 }}>
          <label style={{ display: "block", fontSize: 12, color: "var(--dir-dim)", marginBottom: 8 }}>场景平移</label>
          <div className="flex gap-2">
            {(["x","y","z"] as const).map((k) => (
              <div key={k} className="flex-1 flex items-center gap-[5px] rounded-lg px-2.5" style={{ background: "var(--dir-panel2)" }}>
                <span className="text-xs" style={{ color: "var(--dir-dim)" }}>{k.toUpperCase()}</span>
                <InputNumber size="small" controls={false}
                  className="dir-inputnum" style={{ fontSize: "12.5px", color: "var(--dir-txt)" }}
                  value={parseFloat(sceneState.pos[k].toFixed(2))}
                  step={0.01}
                  onChange={(v) => v != null && (runtime as any)?.setScenePos?.(k, v)} />
              </div>
            ))}
          </div>
        </div>

        {/* 场景旋转 XYZ */}
        <div style={{ marginBottom: 15 }}>
          <label style={{ display: "block", fontSize: 12, color: "var(--dir-dim)", marginBottom: 8 }}>场景旋转</label>
          <div className="flex gap-2">
            {(["x","y","z"] as const).map((k) => (
              <div key={k} className="flex-1 flex items-center gap-[5px] rounded-lg px-2.5" style={{ background: "var(--dir-panel2)" }}>
                <span className="text-xs" style={{ color: "var(--dir-dim)" }}>{k.toUpperCase()}</span>
                <InputNumber size="small" controls={false}
                  className="dir-inputnum" style={{ fontSize: "12.5px", color: "var(--dir-txt)" }}
                  value={Math.round(sceneState.rot[k])}
                  step={1}
                  onChange={(v) => v != null && (runtime as any)?.setSceneRot?.(k, v)} />
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between" style={{ marginBottom: 15 }}>
          <label style={{ fontSize: 12, color: "var(--dir-dim)" }}>天空颜色</label>
          <ColorPicker size="small"
            value={sceneState.sky}
            onChange={(_, hex) => runtime?.setSkyColor(hex)} />
        </div>
      </div>

      {/* Section 2: 全景背景 */}
      <div style={{ borderTop: "1px solid var(--dir-line)", paddingTop: 16, marginTop: 16 }}>
        <div className="sec-title" style={{ fontSize: "13.5px", fontWeight: 600, marginBottom: 14 }}>全景背景</div>
        <div className="flex items-center justify-center gap-2 border border-dashed rounded-[9px] py-4 px-3 text-center"
          style={{ borderColor: "var(--dir-line2)", color: "var(--dir-dim2)", fontSize: 12 }}>
          {sceneState.panoActive ? "全景图已设置" : "底部「全景图」按钮上传"}
        </div>
        <div style={{ marginTop: 14 }}>
          <SliderRow label="水平旋转" min={0} max={360} value={sceneState.panoRot}
            disabled={!sceneState.panoActive}
            format={(v) => `${Math.round(v)}°`}
            onChange={(v) => {/* runtime.setPanoramaRotation stub */}} />
          <SliderRow label="球形半径" min={3} max={200} value={sceneState.panoRadius}
            disabled={!sceneState.panoActive}
            format={(v) => `${Math.round(v)}`}
            onChange={(v) => {/* runtime.setPanoramaRadius stub */}} />
        </div>
      </div>

      {/* Section 3: 角色标签 + 地面 */}
      <div style={{ borderTop: "1px solid var(--dir-line)", paddingTop: 16, marginTop: 16 }}>
        <ToggleRow label="角色标签" checked={sceneState.labels}
          onChange={(v) => runtime?.setLabelsVisible(v)} />
        <div style={{ marginTop: 8 }} />
        <ToggleRow label="地面" checked={sceneState.ground.visible}
          onChange={(v) => runtime?.setGroundVisible(v)} />
        {sceneState.ground.visible && (
          <>
            <SliderRow label="透明度" min={0} max={1} step={0.01}
              value={sceneState.ground.opacity}
              format={(v) => v.toFixed(2)}
              onChange={(v) => runtime?.setGroundOpacity(v)} />
            <SliderRow label="高度" min={-2} max={2} step={0.01}
              value={sceneState.ground.height}
              format={(v) => v.toFixed(1)}
              onChange={(v) => runtime?.setGroundHeight(v)} />
          </>
        )}
      </div>
    </div>
  );
}
