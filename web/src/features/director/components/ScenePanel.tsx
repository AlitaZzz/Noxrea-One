/**
 * 3D 导演台场景全局设置面板。
 * 调节环境天空色、地面显隐与透明度、网格与标签显示等场景级参数，
 * 变更直接作用于 director 运行时。
 */

"use client";

import { useTranslation } from "react-i18next";

import { ColorPicker } from "@/components/ui/color-picker";
import { NumberInput } from "@/components/ui/number-input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useDirectorStore } from "@/features/director/director-store";

function SliderRow({ label, min, max, step = 1, value, disabled, format, onChange }: {
  label?: string; min: number; max: number; step?: number;
  value: number; disabled?: boolean; format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-4">
      {label && <label className="mb-2 block select-none text-xs text-muted-foreground">{label}</label>}
      <div className="flex items-center gap-3">
        <Slider min={min} max={max} step={step} value={[value]} disabled={disabled}
          className="flex-1"
          title={format ? format(value) : String(value)}
          onValueChange={([next]) => onChange(next)} />
        <div className="min-w-14 rounded-md bg-muted px-2.5 py-1.5 text-center text-xs tabular-nums text-muted-foreground">
          {format ? format(value) : value}
        </div>
      </div>
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm font-semibold">{label}</span>
      <Switch size="sm" checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export default function ScenePanel() {
  const { t } = useTranslation();
  const runtime = useDirectorStore((s) => s.runtime);
  const sceneState = useDirectorStore((s) => s.sceneState);

  return (
    <div className="overflow-auto px-4 pb-4 pt-[18px] text-sm">
      <h2 className="mb-1 text-sm font-semibold text-foreground">{t("director.scene3d")}</h2>

      <div className="mt-3.5">
        <SliderRow label={t("director.sceneScale")} min={0.1} max={3} step={0.05} value={sceneState.scale}
          format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => runtime?.setSceneScale(v)} />

        <div className="mb-4">
          <label className="mb-2 block select-none text-xs text-muted-foreground">{t("director.scenePan")}</label>
          <div className="flex gap-2">
            {(["x","y","z"] as const).map((k) => (
              <div key={k} className="flex flex-1 items-center gap-1.5 rounded-md border border-transparent bg-muted px-2.5">
                <span className="select-none text-xs text-muted-foreground">{k.toUpperCase()}</span>
                <NumberInput className="h-7 flex-1 border-0 bg-transparent shadow-none" controls={false}
                  value={parseFloat(sceneState.pos[k].toFixed(2))} step={0.01}
                  onChange={(v) => v != null && runtime?.setScenePos?.(k, v)} />
              </div>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <label className="mb-2 block select-none text-xs text-muted-foreground">{t("director.sceneRotate")}</label>
          <div className="flex gap-2">
            {(["x","y","z"] as const).map((k) => (
              <div key={k} className="flex flex-1 items-center gap-1.5 rounded-md border border-transparent bg-muted px-2.5">
                <span className="select-none text-xs text-muted-foreground">{k.toUpperCase()}</span>
                <NumberInput className="h-7 flex-1 border-0 bg-transparent shadow-none" controls={false}
                  value={Math.round(sceneState.rot[k])} step={1}
                  onChange={(v) => v != null && runtime?.setSceneRot?.(k, v)} />
              </div>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <label className="mb-2 block select-none text-xs text-muted-foreground">{t("director.skyColor")}</label>
          <ColorPicker size="sm" value={sceneState.sky}
            onChange={(hex) => runtime?.setSkyColor(hex)} />
        </div>
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <div className="mb-3.5 mt-1 text-sm font-semibold">{t("director.panoBg")}</div>
        <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {sceneState.panoActive ? t("director.panoSet") : t("director.panoHint")}
        </div>
        <div className="mt-3.5">
          <SliderRow label={t("director.panoRot")} min={0} max={360} value={sceneState.panoRot}
            disabled={!sceneState.panoActive} format={(v) => `${Math.round(v)}°`}
            onChange={() => {}} />
          <SliderRow label={t("director.panoRadius")} min={3} max={200} value={sceneState.panoRadius}
            disabled={!sceneState.panoActive} format={(v) => `${Math.round(v)}`}
            onChange={() => {}} />
        </div>
      </div>

      <div className="mt-4 border-t border-border pt-4">
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
