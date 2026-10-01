import { createInstance } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { fieldDefaults, hasField, toParamFieldViews } from "@/features/model/param-fields";
import type { ParamField } from "@/lib/types/models";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: {
    param: { quality: "Quality", ratio: "Ratio", seconds: "Duration", adaptive: "Adaptive", on: "On", off: "Off",
      unit: { seconds: "s" }, options: { quality: { high: "High", low: "Low" } } },
    audio: { enabled: "With audio", disabled: "Silent", short: "Audio" },
  } } } });
});

describe("model parameter presentation", () => {
  it("preserves false and zero defaults and gates submitted fields against the model schema", () => {
    const fields: ParamField[] = [
      { name: "generateAudio", type: "switch", order: 1, default: false },
      { name: "n", type: "number", order: 2, default: 0 },
      { name: "quality", type: "select", order: 3 },
    ];
    expect(fieldDefaults(fields)).toEqual({ generateAudio: false, n: 0 });
    expect(hasField(fields, "quality")).toBe(true);
    expect(hasField(fields, "seconds")).toBe(false);
  });

  it("resolves order, translated option labels, units and adaptive ratios without mutating the schema", () => {
    const fields: ParamField[] = [
      { name: "seconds", type: "slider", order: 3, default: 5, min: 2, max: 10 },
      { name: "ratio", type: "select", order: 2, ratio: true, options: ["16:9", "adaptive"] },
      { name: "quality", type: "segmented", order: 1, options: ["high", "low"] },
    ];
    const views = toParamFieldViews(fields, i18n.t);
    expect(views.map((field) => field.label)).toEqual(["Quality", "Ratio", "Duration"]);
    expect(views[0].options).toEqual([{ value: "high", label: "High" }, { value: "low", label: "Low" }]);
    expect(views[1].options).toEqual([
      { value: "16:9", label: "16:9", aspectRatio: { width: 16, height: 9 } },
      { value: "adaptive", label: "Adaptive", aspectRatio: { width: 1, height: 1 } },
    ]);
    expect(views[1].formatValue("adaptive")).toBe("Adaptive");
    expect(views[2].formatValue(5)).toBe("5s");
    expect(views[2]).toMatchObject({ min: 2, max: 10, step: 1, defaultValue: 5 });
    expect(fields[0].name).toBe("seconds");
  });

  it("keeps full switch labels and compact summary labels distinct", () => {
    const [view] = toParamFieldViews([{ name: "generateAudio", type: "switch", order: 1,
      trueLabel: "audio.enabled", falseLabel: "audio.disabled", trueShort: "audio.short" }], i18n.t);
    expect(view.options).toEqual([{ value: true, label: "With audio" }, { value: false, label: "Silent" }]);
    expect(view.formatValue(true)).toBe("Audio");
    expect(view.formatValue(false)).toBe("Silent");
  });

  it("returns no display fields before configuration is available", () => {
    expect(toParamFieldViews([], i18n.t)).toEqual([]);
    expect(fieldDefaults([])).toEqual({});
  });
});
