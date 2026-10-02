"use client";

import { cn } from "cn";
import { memo } from "react";

import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { Slider } from "@/components/ui/slider";

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
          <div className="mb-1.5 text-xs text-muted-foreground">{field.label}</div>
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
      <NumberInput
        className={field.type === "slider" ? "h-7 w-9 border-0 bg-transparent p-0 text-[13px] text-foreground shadow-none" : undefined}
        min={field.min} max={field.max} step={field.step} value={num}
        onChange={(v) => { if (field.type === "number" || v !== null) onChange(v); }}
        controls={field.type === "slider" ? false : undefined}
      />
    );
    if (field.type === "number") return input;
    return (
      <div className="flex items-center gap-3">
        <Slider min={field.min} max={field.max} step={field.step}
          value={num === undefined ? undefined : [num]}
          defaultValue={num === undefined ? [field.min ?? 0] : undefined}
          onValueChange={([next]) => onChange(next)} className="flex-1" />
        <div className="flex min-w-12 items-center rounded-md bg-secondary px-1.5 py-0.5">
          {input}
          <span className="ml-0.5 text-xs text-foreground">{field.unit}</span>
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
          <Button
            key={String(option.value)}
            variant="outline"
            className={cn(
              "h-auto min-h-9 whitespace-normal px-2 py-1",
              "aria-pressed:border-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground",
              isRatio && "min-h-12 flex-col gap-1 px-0.5 py-2",
            )}
            aria-pressed={active}
            onClick={() => onChange(option.value)}>
            {isRatio && ratio && (
              <span className="flex h-5 items-center justify-center">
                <span className={cn("border", active ? "border-foreground" : "border-input")} style={{
                  width: Math.max(4, Math.round(18 * ratio.width / max)),
                  height: Math.max(4, Math.round(18 * ratio.height / max)),
                }} />
              </span>
            )}
            <span className={isRatio ? "text-xs leading-none" : undefined}>{option.label}</span>
          </Button>
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
