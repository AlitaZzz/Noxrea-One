/**
 * ParamFields 通用参数渲染器。
 * 以 model-ui 的 fields 声明为唯一数据源，按 type 分发控件、按 order 排序。
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

/** 标签 key：显式 label 优先，否则按字段 name 推导到 param.<name> */
export function resolveLabel(f: ParamField): string {
  return f.label ?? `param.${f.name}`;
}

/** 单位 key：显式 unit 优先；ratio 图形字段不显示单位；仅带量纲的 slider/number 按 name 推导到 param.unit.<name> */
export function resolveUnit(f: ParamField): string | undefined {
  if (f.ratio) return undefined;
  if (f.unit) return f.unit;
  if (f.type === "slider" || f.type === "number") return `param.unit.${f.name}`;
  return undefined;
}

/** 选项翻译前缀：显式 optionI18nPrefix 优先；仅 segmented 且全文本选项才按 name 推导到 param.options.<name>，其余显示原值 */
export function resolveOptionPrefix(f: ParamField, hasOptions: boolean): string | undefined {
  if (f.ratio) return undefined;
  if (f.optionI18nPrefix) return f.optionI18nPrefix;
  if (!hasOptions || f.type !== "segmented") return undefined;
  const options = (f.options ?? []) as unknown[];
  if (!options.every((o) => typeof o === "string")) return undefined;
  return `param.options.${f.name}`;
}

const ParamFields = memo(function ParamFields({ fields, values, onChange }: ParamFieldsProps) {
  const { t } = useTranslation();
  const sorted = [...fields].sort((a, b) => a.order - b.order);

  return (
    <div className="flex flex-col gap-4">
      {sorted.map((f) => (
        <div key={f.name}>
          <div className="text-xs mb-1.5" style={{ color: "var(--canvas-text-muted)" }}>
            {t(resolveLabel(f))}
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
    case "slider": {
      const unitKey = resolveUnit(field);
      return (
        <Slider
          min={field.min ?? 1}
          max={field.max ?? 15}
          step={field.step ?? 1}
          value={typeof value === "number" ? value : (field.default as number ?? 1)}
          onChange={(v) => onChange(v)}
          style={{ margin: "0 4px" }}
          tooltip={{ formatter: (v) => `${v}${unitKey ? t(unitKey) : ""}` }}
        />
      );
    }
    case "switch":
      return (
        <div className="grid grid-cols-2 gap-1">
          {[true, false].map((v) => {
            const active = value === v;
            const label = v ? t(field.trueLabel ?? "param.on") : t(field.falseLabel ?? "param.off");
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
        const optionPrefix = resolveOptionPrefix(field, options.length > 0);
        const unitKey = resolveUnit(field);
        const label = `${optionPrefix ? t(`${optionPrefix}.${v}`) : v}${unitKey && !optionPrefix ? t(unitKey) : ""}`;
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

function RatioGrid({ field, value, onChange, t }: Ctx & { t: (key: string) => string }) {
  const options = (field.options ?? []) as string[];
  return (
    <div className="grid grid-cols-5 gap-1">
      {options.map((v) => {
        const maxDim = 18;
        const parsed = (v === "adaptive" ? "1:1" : v).split(":").map(Number);
        const [w, h] = Number.isFinite(parsed[0]) && Number.isFinite(parsed[1]) ? [parsed[0], parsed[1]] : [1, 1];
        const boxW = Math.max(4, Math.round(maxDim * Math.min(1, w / Math.max(w, h))));
        const boxH = Math.max(4, Math.round(maxDim * Math.min(1, h / Math.max(w, h))));
        const active = value === v;
        const label = v === "adaptive" ? t("param.adaptive") : v;
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
            <span className="text-xs mt-1 leading-none" style={{ color: active ? "var(--canvas-text)" : "var(--canvas-text-muted)" }}>{label}</span>
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
        return v ? t(f.trueShort ?? f.trueLabel ?? "param.on") : t(f.falseShort ?? f.falseLabel ?? "param.off");
      }
      if (f.type === "slider") {
        const uk = resolveUnit(f);
        return `${v}${uk ? t(uk) : ""}`;
      }
      const optionPrefix = resolveOptionPrefix(f, (f.options?.length ?? 0) > 0);
      const uk = resolveUnit(f);
      const label = optionPrefix ? t(`${optionPrefix}.${v}`) : (f.ratio && v === "adaptive" ? t("param.adaptive") : String(v));
      return uk && !f.ratio ? `${label}${t(uk)}` : label;
    })
    .filter(Boolean) as string[];

  return <>{rendered.join(" · ")}</>;
});

function btnStyle(active: boolean): React.CSSProperties {
  return {
    height: "auto",
    minHeight: 36,
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