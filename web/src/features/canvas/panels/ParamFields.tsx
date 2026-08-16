/**
 * ParamFields 通用参数渲染器。
 * 以 model-params 的 fields 声明为唯一数据源，按 type 分发控件、按 order 排序。
 * 支持：segmented / select / slider / switch / number。
 */
"use client";

import { Button, InputNumber, Slider } from "antd";
import { memo } from "react";
import { useTranslation } from "react-i18next";

import type { ParamField } from "@/lib/types/models";

interface ParamFieldsProps {
  fields: ParamField[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
}

/** 提取 fields 的默认值映射（name -> default），供初始状态使用 */
export function fieldDefaults(fields: ParamField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.default !== undefined) out[f.name] = f.default;
  }
  return out;
}

/** 判断某字段是否在 fields 中声明（用于提交时决定是否上报） */
export function hasField(fields: ParamField[], name: string): boolean {
  return fields.some((f) => f.name === name);
}

const ParamFields = memo(function ParamFields({ fields, values, onChange }: ParamFieldsProps) {
  const { t } = useTranslation();
  const sorted = [...fields].sort((a, b) => a.order - b.order);

  return (
    <div className="flex flex-col gap-3">
      {sorted.map((f) => (
        <div key={f.name}>
          <div className="text-xs mb-1.5" style={{ color: "var(--canvas-text-muted)" }}>
            {t(f.label)}
          </div>
          <FieldControl field={f} value={values[f.name]} onChange={(v) => onChange(f.name, v)} t={t} />
        </div>
      ))}
    </div>
  );
});

export default ParamFields;

function FieldControl({
  field,
  value,
  onChange,
  t,
}: {
  field: ParamField;
  value: unknown;
  onChange: (value: unknown) => void;
  t: (key: string) => string;
}) {
  switch (field.type) {
    case "segmented":
      return <SegmentedGrid field={field} value={value} onChange={onChange} t={t} />;
    case "select":
      return field.ratio
        ? <RatioGrid field={field} value={value} onChange={onChange} t={t} />
        : <SelectGrid field={field} value={value} onChange={onChange} t={t} />;
    case "slider":
      return (
        <Slider
          min={field.min ?? 1}
          max={field.max ?? 15}
          step={field.step ?? 1}
          value={typeof value === "number" ? value : (field.default as number ?? 1)}
          onChange={(v) => onChange(v)}
          style={{ margin: "0 4px" }}
          tooltip={{ formatter: (v) => `${v}${field.unit ? t(field.unit) : ""}` }}
        />
      );
    case "switch":
      return (
        <div className="grid grid-cols-2 gap-1">
          {[true, false].map((v) => {
            const active = value === v;
            const label = v ? t(field.trueLabel ?? "common.on") : t(field.falseLabel ?? "common.off");
            return (
              <Button size="small" type="text" key={String(v)} className="rounded-md text-[13px] transition-colors"
                style={btnStyle(active as boolean)}
                onMouseEnter={hoverStyle(active as boolean)}
                onMouseLeave={leaveStyle(active as boolean)}
                onClick={() => onChange(v)}>
                {label}
              </Button>
            );
          })}
        </div>
      );
    case "number":
      return (
        <InputNumber
          size="small"
          min={field.min}
          max={field.max}
          step={field.step}
          value={typeof value === "number" ? value : (field.default as number)}
          onChange={(v) => onChange(v)}
          style={{ width: "100%" }}
        />
      );
    default:
      return null;
  }
}

function SegmentedGrid({ field, value, onChange, t }: Ctx) {
  const options = (field.options ?? []) as (string | number)[];
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(options.length, 4)}, minmax(0, 1fr))` }}>
      {options.map((v) => {
        const active = value === v;
        const label = `${field.optionI18nPrefix ? t(`${field.optionI18nPrefix}.${v}`) : v}${field.unit && !field.optionI18nPrefix ? t(field.unit) : ""}`;
        return (
          <Button size="small" type="text" key={String(v)} className="rounded-md text-[13px] transition-colors"
            style={btnStyle(active)}
            onMouseEnter={hoverStyle(active)}
            onMouseLeave={leaveStyle(active)}
            onClick={() => onChange(v)}>
            {label}
          </Button>
        );
      })}
    </div>
  );
}

function SelectGrid({ field, value, onChange }: Ctx) {
  const options = (field.options ?? []) as (string | number)[];
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.min(options.length, 4)}, minmax(0, 1fr))` }}>
      {options.map((v) => {
        const active = value === v;
        return (
          <Button size="small" type="text" key={String(v)} className="rounded-md text-[13px] transition-colors"
            style={btnStyle(active)}
            onMouseEnter={hoverStyle(active)}
            onMouseLeave={leaveStyle(active)}
            onClick={() => onChange(v)}>
            {v}
          </Button>
        );
      })}
    </div>
  );
}

function RatioGrid({ field, value, onChange }: Ctx) {
  const options = (field.options ?? []) as string[];
  return (
    <div className="grid grid-cols-5 gap-1">
      {options.map((v) => {
        const [w, h] = v.split(":").map(Number);
        const maxDim = 18;
        const boxW = Math.max(4, Math.round(maxDim * Math.min(1, w / Math.max(w, h))));
        const boxH = Math.max(4, Math.round(maxDim * Math.min(1, h / Math.max(w, h))));
        const active = value === v;
        return (
          <Button size="small" type="text" key={v} className="flex flex-col items-center justify-center rounded-md transition-colors"
            style={{ height: "auto", minHeight: 48, padding: "8px 2px", background: active ? "var(--canvas-bg-hover, #3c3c3c)" : "transparent", border: `1px solid ${active ? "var(--canvas-text)" : "#555"}`, cursor: "pointer" }}
            onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--canvas-bg-hover, #3c3c3c)"; }}
            onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            onClick={() => onChange(v)}>
            <div className="flex items-center justify-center" style={{ height: 20 }}>
              <div className="border"
                style={{ width: boxW, height: boxH, borderColor: active ? "var(--canvas-text)" : "var(--canvas-border-light)", transition: "border-color 0.15s" }} />
            </div>
            <span className="text-xs mt-1 leading-none" style={{ color: active ? "var(--canvas-text)" : "var(--canvas-text-muted)" }}>{v}</span>
          </Button>
        );
      })}
    </div>
  );
}

interface Ctx {
  field: ParamField;
  value: unknown;
  onChange: (value: unknown) => void;
  t: (key: string) => string;
}

/** 触发按钮的紧凑摘要：按 order 渲染当前值，用 " · " 分隔 */
export const ParamSummary = memo(function ParamSummary({
  fields,
  values,
}: {
  fields: ParamField[];
  values: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const sorted = [...fields].sort((a, b) => a.order - b.order);
  const rendered = sorted
    .map((f) => {
      const v = values[f.name];
      if (v === undefined || v === null || v === "") return null;
      if (f.type === "switch") {
        return v ? t(f.trueShort ?? f.trueLabel ?? "common.on") : t(f.falseShort ?? f.falseLabel ?? "common.off");
      }
      if (f.type === "slider") {
        return `${v}${f.unit ? t(f.unit) : ""}`;
      }
      const label = f.optionI18nPrefix ? t(`${f.optionI18nPrefix}.${v}`) : String(v);
      return f.unit ? `${label}${f.ratio ? "" : t(f.unit)}` : label;
    })
    .filter(Boolean) as string[];

  return <>{rendered.join(" · ")}</>;
});

function btnStyle(active: boolean): React.CSSProperties {
  return {
    padding: "4px 8px",
    background: active ? "var(--canvas-bg-hover, #3c3c3c)" : "transparent",
    color: active ? "var(--canvas-text)" : "var(--canvas-text-muted)",
    border: `1px solid ${active ? "var(--canvas-text)" : "#555"}`,
    cursor: "pointer",
  };
}

function hoverStyle(active: boolean) {
  return (e: React.MouseEvent<HTMLElement>) => {
    if (!active) (e.currentTarget as HTMLElement).style.background = "var(--canvas-bg-hover, #3c3c3c)";
  };
}

function leaveStyle(active: boolean) {
  return (e: React.MouseEvent<HTMLElement>) => {
    if (!active) (e.currentTarget as HTMLElement).style.background = "transparent";
  };
}