/**
 * 3D 导演台场景全局设置面板。
 * 调节环境天空色、地面显隐与透明度、网格与标签显示等场景级参数，
 * 变更直接作用于 director 运行时。
 */
"use client";

import { ColorPicker, InputNumber,Slider, Switch } from "antd";
import { useTranslation } from "react-i18next";

import { useDirectorStore } from "@/features/director/director-store";

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
  const { t } = useTranslation();
  const runtime = useDirectorStore((s) => s.runtime);
  const sceneState = useDirectorStore((s) => s.sceneState);

  return (
    <div className="dir-rp-pad text-sm overflow-auto">
      <h2 className="dir-h2">{t("director.scene3d")}</h2>

      <div className="dir-sec-first">
        <SliderRow label={t("director.sceneScale")} min={0.1} max={3} step={0.05} value={sceneState.scale}
          format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => runtime?.setSceneScale(v)} />

        <div className="dir-field">
          <label className="dir-label">{t("director.scenePan")}</label>
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
          <label className="dir-label">{t("director.sceneRotate")}</label>
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
          <label className="dir-label">{t("director.skyColor")}</label>
          <ColorPicker size="small" value={sceneState.sky}
            onChange={(c) => runtime?.setSkyColor(c.toHexString())} />
        </div>
      </div>

      <div className="dir-sec">
        <div className="dir-sec-title">{t("director.panoBg")}</div>
        <div className="dir-placeholder">{sceneState.panoActive ? t("director.panoSet") : t("director.panoHint")}</div>
        <div style={{ marginTop: 14 }}>
          <SliderRow label={t("director.panoRot")} min={0} max={360} value={sceneState.panoRot}
            disabled={!sceneState.panoActive} format={(v) => `${Math.round(v)}°`}
            onChange={() => {}} />
          <SliderRow label={t("director.panoRadius")} min={3} max={200} value={sceneState.panoRadius}
            disabled={!sceneState.panoActive} format={(v) => `${Math.round(v)}`}
            onChange={() => {}} />
        </div>
      </div>

      <div className="dir-sec">
        <ToggleRow label={t("director.charLabels")} checked={sceneState.labels} onChange={(v) => runtime?.setLabelsVisible(v)} />
        <ToggleRow label={t("director.ground")} checked={sceneState.ground.visible} onChange={(v) => runtime?.setGroundVisible(v)} />
        {sceneState.ground.visible && (<>
          <SliderRow label={t("director.opacity")} min={0} max={1} step={0.01} value={sceneState.ground.opacity}
            format={(v) => v.toFixed(2)} onChange={(v) => runtime?.setGroundOpacity(v)} />
          <SliderRow label={t("director.height")} min={-2} max={2} step={0.01} value={sceneState.ground.height}
            format={(v) => v.toFixed(1)} onChange={(v) => runtime?.setGroundHeight(v)} />
        </>)}
      </div>

    </div>
  );
}
