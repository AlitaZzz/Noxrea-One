"use client";

import { memo } from "react";

import AppButton from "@/components/ui/AppButton";
import AppNumberInput from "@/components/ui/AppNumberInput";
import AppSlider from "@/components/ui/AppSlider";

export interface ParamOptionView {
  value: string | number | boolean;
  label: string;
  aspectRatio?: { width: number; height: number };
}

/** Display data is resolved by the caller; this renderer has no model conventions. */
export interface ParamFieldView {
  name: string;
  type: "segmented" | "select" | "ratio" | "slider" | "switch" | "number";
  label: string;
  options?: ParamOptionView[];
  defaultValue?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  formatValue: (value: unknown) => string;
}

interface ParamFieldsProps {
  fields: ParamFieldView[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
}

const ParamFields = memo(function ParamFields({ fields, values, onChange }: ParamFieldsProps) {
  return (
    <div className="flex flex-col gap-4">
      {fields.map((field) => (
        <div key={field.name}>
          <div className="text-xs mb-1.5" style={{ color: "var(--canvas-text-muted)" }}>{field.label}</div>
          <FieldControl field={field} value={values[field.name]} onChange={(v) => onChange(field.name, v)} />
        </div>
      ))}
    </div>
  );
});

export default ParamFields;

function FieldControl({ field, value, onChange }: {
  field: ParamFieldView;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (field.type === "slider" || field.type === "number") {
    const num = typeof value === "number" ? value : typeof field.defaultValue === "number" ? field.defaultValue : undefined;
    const input = (
      <AppNumberInput
        className={field.type === "slider" ? "param-num-input" : undefined}
        size="small"
        min={field.min} max={field.max} step={field.step} value={num}
        onChange={(v) => { if (field.type === "number" || v !== null) onChange(v); }}
        variant={field.type === "slider" ? "borderless" : undefined}
        controls={field.type === "slider" ? false : undefined}
        style={field.type === "slider" ? { width: 36, color: "var(--canvas-text)", fontSize: 13 } : { width: "100%" }}
      />
    );
    if (field.type === "number") return input;
    return (
      <div className="flex items-center gap-3">
        <AppSlider min={field.min} max={field.max} step={field.step} value={num}
          onChange={onChange} style={{ flex: 1, margin: 0 }} showTooltip={false} />
        <div className="flex items-center rounded-md" style={{ background: "var(--canvas-bg-active, #33333a)", padding: "2px 6px", minWidth: 48 }}>
          {input}
          <span className="text-xs ml-0.5" style={{ color: "var(--canvas-text)" }}>{field.unit}</span>
        </div>
      </div>
    );
  }

  const options = field.options ?? [];
  const isRatio = field.type === "ratio";
  if (options.length === 0) return null;
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${isRatio ? 5 : Math.min(options.length, 4)}, minmax(0, 1fr))` }}>
      {options.map((option) => {
        const active = value === option.value;
        const ratio = option.aspectRatio;
        const max = ratio ? Math.max(ratio.width, ratio.height) : 1;
        return (
          <AppButton key={String(option.value)} variant="ghost" className="param-option" aria-pressed={active}
            style={isRatio ? { minHeight: 48, padding: "8px 2px", flexDirection: "column", gap: 4 } : undefined}
            onClick={() => onChange(option.value)}>
            {isRatio && ratio && (
              <span className="flex items-center justify-center" style={{ height: 20 }}>
                <span className="border" style={{
                  width: Math.max(4, Math.round(18 * ratio.width / max)),
                  height: Math.max(4, Math.round(18 * ratio.height / max)),
                  borderColor: active ? "var(--canvas-text)" : "var(--canvas-border-light)",
                }} />
              </span>
            )}
            <span className={isRatio ? "text-xs leading-none" : undefined}>{option.label}</span>
          </AppButton>
        );
      })}
    </div>
  );
}

export const ParamSummary = memo(function ParamSummary({ fields, values }: Pick<ParamFieldsProps, "fields" | "values">) {
  const rendered = fields.flatMap((field) => {
    const value = values[field.name];
    return value === undefined || value === null || value === "" ? [] : [field.formatValue(value)];
  });
  return <>{rendered.join(" · ")}</>;
});
