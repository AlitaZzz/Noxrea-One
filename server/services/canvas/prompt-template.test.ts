import { describe, expect, it } from "vitest";

import catalog from "../../resources/prompt-template.json";
import { renderAngleTemplate } from "./angle-prompt";
import { renderLightingTemplate } from "./lighting-prompt";
import { azimuthBase } from "./prompt-utils";

const entries = catalog.entries;
const lighting = entries.find((entry) => entry.id === "lighting")!.template;
const angle = entries.find((entry) => entry.id === "angle")!.template;
const chinese = /[㐀-鿿]/;

function expectFinishedEnglish(result: string) {
  expect(result).not.toMatch(chinese);
  expect(result).not.toMatch(/\{\{\w+\}\}/);
}

describe("prompt template catalog", () => {
  it("contains exactly nine ordered presets and three non-preset templates in English", () => {
    const presets = entries.filter((entry) => entry.kind === "preset");
    expect(presets.map((entry) => entry.id)).toEqual([
      "characterFaceThreeView", "characterThreeView", "productThreeView", "cinematicLightCorrection",
      "nineGridScene", "storyboard25", "storyboard4", "forward3s", "back5s",
    ]);
    expect(presets.map((entry) => entry.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(presets.every((entry) => Boolean(entry.labelKey && entry.template))).toBe(true);
    expect(entries.filter((entry) => entry.kind !== "preset").map((entry) => entry.id))
      .toEqual(["reverse", "lighting", "angle"]);
    expect(entries.find((entry) => entry.id === "reverse"))
      .toMatchObject({ kind: "reverse", labelKey: "node.creationReverse", order: 0 });
    expect(entries.some((entry) => entry.id === "expand" || entry.id === "stylize")).toBe(false);
    for (const entry of entries) expect(entry.template).not.toMatch(chinese);
  });

  it("preserves the nine-view camera order and the separate caption constraints", () => {
    const template = entries.find((entry) => entry.id === "nineGridScene")!.template;
    for (const [index, caption] of [
      "ELS | Front Eye-Level", "LS | Front-Right 45°", "MLS | Right Side 90°",
      "MS | Front-Left 45°", "MCU | Aerial Top-Down", "CU | Rear-Right 45°",
      "ECU | Left Side 90°", "Low Angle | Rear-Left 45°", "High Angle | Rear Eye-Level",
    ].entries()) {
      expect(template).toContain(`${index + 1}. ${caption}`);
    }
    expect(template).toContain("Do not let captions cover the subject or enter the scene image");
    expect(template).toContain("never the subject's actual size, proportions, structure, or object positions");
  });

  it("keeps future and preceding frames unambiguous", () => {
    expect(entries.find((entry) => entry.id === "forward3s")!.template)
      .toContain("approximately 3 seconds after the reference image");
    expect(entries.find((entry) => entry.id === "back5s")!.template)
      .toContain("approximately 5 seconds before the reference image");
  });
});

describe("lighting interpolation", () => {
  it("maps eight azimuth sectors and wraps positive/negative angles", () => {
    expect([0, 45, 90, 135, 180, 225, 270, 315].map(azimuthBase))
      .toEqual(["front", "front-right", "right", "rear-right", "rear", "rear-left", "left", "front-left"]);
    expect(azimuthBase(-45)).toBe("front-left");
    expect(azimuthBase(405)).toBe("front-right");
  });

  it("expresses oblique and vertical lighting without conflicting directions", () => {
    const oblique = renderLightingTemplate(lighting, { azimuth: "270", elevation: "16", intensity: "40", kelvin: "3500" });
    expect(oblique).toContain("above and to the left of the scene, shining diagonally downward");
    expect(oblique).toContain("warm yellow light (approximately 3500K)");
    expect(oblique).toContain("soft (approximately 40%)");
    const overhead = renderLightingTemplate(lighting, { azimuth: "270", elevation: "60" });
    expect(overhead).toContain("directly above the scene, shining vertically downward");
    expect(overhead).not.toContain("left of the scene");
    expect(renderLightingTemplate(lighting, { azimuth: "90", elevation: "-60" }))
      .toContain("directly below the scene, shining vertically upward");
    expectFinishedEnglish(oblique);
  });

  it("clamps numeric boundaries while retaining exact K, percent and custom hex values", () => {
    const low = renderLightingTemplate(lighting, { intensity: "-2", kelvin: "100", elevation: "-500" });
    expect(low).toContain("very low (approximately 10%)");
    expect(low).toContain("candle-like warm orange light (approximately 1500K)");
    const high = renderLightingTemplate(lighting, { intensity: "500", kelvin: "20000", elevation: "500" });
    expect(high).toContain("very strong (approximately 100%)");
    expect(high).toContain("cool blue light (approximately 10000K)");
    expect(renderLightingTemplate(lighting, { color: "#aabbcc" })).toContain("custom-colored light (#aabbcc)");
    expectFinishedEnglish(high);
    expectFinishedEnglish(low);
  });
});

describe("angle interpolation", () => {
  it("describes rear view reconstruction and does not trigger it in diagonal or vertical views", () => {
    const rear = renderAngleTemplate(angle, { azimuth: "180", elevation: "60", zoom: "2" });
    expect(rear).toContain("directly behind the subject (azimuth approximately 180°)");
    expect(rear).toContain("looking down from above (elevation approximately 60°)");
    expect(rear).toContain("wide shot");
    expect(rear).toContain("Reconstruct the parts of the subject's back");
    expect(renderAngleTemplate(angle, { azimuth: "135" })).not.toContain("Reconstruct");
    const overhead = renderAngleTemplate(angle, { azimuth: "180", elevation: "61" });
    expect(overhead).toContain("directly above the subject, looking straight down from above");
    expect(overhead).not.toContain("Reconstruct");
    expectFinishedEnglish(rear);
    expectFinishedEnglish(overhead);
  });

  it("wraps azimuth and clamps elevation and zoom to their original ranges", () => {
    const bottom = renderAngleTemplate(angle, { azimuth: "-90", elevation: "-90", zoom: "-9" });
    expect(bottom).toContain("directly below the subject, looking straight up from below (elevation approximately -90°)");
    expect(bottom).toContain("close-up");
    const front = renderAngleTemplate(angle, { azimuth: "360", elevation: "-60", zoom: "1" });
    expect(front).toContain("directly in front of the subject (azimuth approximately 0°)");
    expect(front).toContain("looking up from below (elevation approximately -60°)");
    expect(front).toContain("medium shot");
    expectFinishedEnglish(bottom);
    expectFinishedEnglish(front);
  });
});
