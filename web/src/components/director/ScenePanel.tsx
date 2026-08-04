"use client";

import { ColorPicker, InputNumber,Slider, Switch } from "antd";

import { useDirectorStore } from "@/director/store";

function SliderRow({ label, min, max, step = 1, value, disabled, format, onChange }: {
  label?: string; min: number; max: number; step?: number;
  value: number; disabled?: boolean; format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="dir-field">
      {label && <label className="dir-label">{label}</label>}
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

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="toggle-label">{label}</span>
      <Switch size="small" checked={checked} onChange={onChange} />
    </div>
  );
}

export default function ScenePanel() {
  const runtime = useDirectorStore((s) => s.runtime);
  const sceneState = useDirectorStore((s) => s.sceneState);

  return (
    <div className="dir-rp-pad text-sm overflow-auto">
      <h2 className="dir-h2">3D场景</h2>

      <div className="dir-sec-first">
        <SliderRow label="场景缩放" min={0.1} max={3} step={0.05} value={sceneState.scale}
          format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => runtime?.setSceneScale(v)} />

        <div className="dir-field">
          <label className="dir-label">场景平移</label>
          <div className="flex gap-2">
            {(["x","y","z"] as const).map((k) => (
              <div key={k} className="dir-fld flex-1">
                <span className="dir-ax">{k.toUpperCase()}</span>
                <InputNumber size="small" className="dir-inputnum flex-1" controls={false}
                  value={parseFloat(sceneState.pos[k].toFixed(2))} step={0.01}
                  onChange={(v) => v != null && runtime?.setScenePos?.(k, v)} />
              </div>
            ))}
          </div>
        </div>

        <div className="dir-field">
          <label className="dir-label">场景旋转</label>
          <div className="flex gap-2">
            {(["x","y","z"] as const).map((k) => (
              <div key={k} className="dir-fld flex-1">
                <span className="dir-ax">{k.toUpperCase()}</span>
                <InputNumber size="small" className="dir-inputnum flex-1" controls={false}
                  value={Math.round(sceneState.rot[k])} step={1}
                  onChange={(v) => v != null && runtime?.setSceneRot?.(k, v)} />
              </div>
            ))}
          </div>
        </div>

        <div className="dir-field">
          <label className="dir-label">天空颜色</label>
          <ColorPicker size="small" value={sceneState.sky}
            onChange={(c) => runtime?.setSkyColor(c.toHexString())} />
        </div>
      </div>

      <div className="dir-sec">
        <div className="dir-sec-title">全景背景</div>
        <div className="dir-placeholder">{sceneState.panoActive ? "全景图已设置" : "底部「全景图」按钮上传"}</div>
        <div style={{ marginTop: 14 }}>
          <SliderRow label="水平旋转" min={0} max={360} value={sceneState.panoRot}
            disabled={!sceneState.panoActive} format={(v) => `${Math.round(v)}°`}
            onChange={() => {}} />
          <SliderRow label="球形半径" min={3} max={200} value={sceneState.panoRadius}
            disabled={!sceneState.panoActive} format={(v) => `${Math.round(v)}`}
            onChange={() => {}} />
        </div>
      </div>

      <div className="dir-sec">
        <ToggleRow label="角色标签" checked={sceneState.labels} onChange={(v) => runtime?.setLabelsVisible(v)} />
        <ToggleRow label="地面" checked={sceneState.ground.visible} onChange={(v) => runtime?.setGroundVisible(v)} />
        {sceneState.ground.visible && (<>
          <SliderRow label="透明度" min={0} max={1} step={0.01} value={sceneState.ground.opacity}
            format={(v) => v.toFixed(2)} onChange={(v) => runtime?.setGroundOpacity(v)} />
          <SliderRow label="高度" min={-2} max={2} step={0.01} value={sceneState.ground.height}
            format={(v) => v.toFixed(1)} onChange={(v) => runtime?.setGroundHeight(v)} />
        </>)}
      </div>

    </div>
  );
}
