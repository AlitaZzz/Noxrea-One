import type { TFunction } from "i18next";

import type { ParamFieldView, ParamOptionView } from "@/components/ui/ParamFields";
import type { ParamField } from "@/lib/types/models";

export function fieldDefaults(fields: ParamField[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => field.default !== undefined).map((field) => [field.name, field.default]));
}

export function hasField(fields: ParamField[], name: string): boolean {
  return fields.some((field) => field.name === name);
}

/** Resolve the model schema into UI data, including translation and adaptive ratio semantics. */
export function toParamFieldViews(fields: ParamField[], t: TFunction): ParamFieldView[] {
  return [...fields].sort((a, b) => a.order - b.order).map((field) => {
    const unitKey = field.ratio ? undefined : field.unit ?? (
      field.type === "slider" || field.type === "number" ? `param.unit.${field.name}` : undefined
    );
    const unit = unitKey ? t(unitKey) : "";
    const prefix = field.ratio ? undefined : field.optionI18nPrefix ?? (
      field.type === "segmented" && (field.options?.length ?? 0) > 0 && field.options!.every((v) => typeof v === "string")
        ? `param.options.${field.name}` : undefined
    );
    const formatValue = (value: unknown): string => {
      if (field.type === "switch") return value
        ? t(field.trueShort ?? field.trueLabel ?? "param.on")
        : t(field.falseShort ?? field.falseLabel ?? "param.off");
      if (field.type === "slider") return `${value}${unit}`;
      const label = prefix ? t(`${prefix}.${value}`)
        : field.ratio && value === "adaptive" ? t("param.adaptive") : String(value);
      return `${label}${unit && !prefix && !field.ratio ? unit : ""}`;
    };
    const options: ParamOptionView[] = field.type === "switch"
      ? [
        { value: true, label: t(field.trueLabel ?? "param.on") },
        { value: false, label: t(field.falseLabel ?? "param.off") },
      ]
      : (field.options ?? []).map((value) => {
        const label = field.type === "select" && !field.ratio ? String(value) : formatValue(value);
        if (!field.ratio) return { value, label };
        const [width, height] = (value === "adaptive" ? "1:1" : String(value)).split(":").map(Number);
        const aspectRatio = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
          ? { width, height } : { width: 1, height: 1 };
        return { value, label, aspectRatio };
      });
    return {
      name: field.name,
      type: field.type === "select" && field.ratio ? "ratio" : field.type,
      label: t(field.label ?? `param.${field.name}`),
      options,
      defaultValue: field.default,
      min: field.min ?? (field.type === "slider" ? 1 : undefined),
      max: field.max ?? (field.type === "slider" ? 15 : undefined),
      step: field.step ?? (field.type === "slider" ? 1 : undefined),
      unit,
      formatValue,
    };
  });
}
