import { describe, expect, it } from "vitest";

import catalog from "../../resources/prompt-template.json";
import { renderAngleTemplate } from "./angle-prompt";
import { renderLightingTemplate } from "./lighting-prompt";
import { azimuthBase } from "./prompt-utils";

const entries = catalog.entries;
const groups = catalog.groups;
const lighting = entries.find((entry) => entry.id === "lighting")!.template;
const angle = entries.find((entry) => entry.id === "angle")!.template;
const chinese = /[㐀-鿿]/;

function expectFinishedEnglish(result: string) {
  expect(result).not.toMatch(chinese);
  expect(result).not.toMatch(/\{\{\w+\}\}/);
}

describe("prompt template catalog", () => {
  it("contains ordered image and text presets plus dynamic templates in English", () => {
    const presets = entries.filter((entry) => entry.kind === "preset");
    const imagePresets = presets.filter((entry) => entry.target === "image");
    expect(imagePresets.map((entry) => entry.id)).toEqual([
      "characterFaceThreeView", "characterThreeView", "productThreeView", "cinematicLightCorrection",
      "nineGridScene", "storyboard25", "storyboard4", "forward3s", "back5s",
    ]);
    expect(imagePresets.map((entry) => entry.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const textPresets = presets.filter((entry) => entry.target === "text");
    expect(textPresets.map((entry) => entry.id)).toEqual(["reverse", "expand"]);
    expect(textPresets.map((entry) => entry.order)).toEqual([10, 11]);
    expect(entries.filter((entry) => entry.kind !== "preset").map((entry) => entry.id))
      .toEqual(["lighting", "angle"]);
    for (const entry of entries) expect(entry.template).not.toMatch(chinese);
  });

  it("provides inline bilingual labels, descriptions and a valid group for every menu entry", () => {
    const groupIds = new Set(groups.map((group) => group.id));
    expect(groupIds.size).toBe(groups.length);
    expect([...groupIds]).toEqual([...groups].sort((a, b) => a.order - b.order).map((group) => group.id));
    for (const group of groups) {
      expect(group.label).toMatchObject({ zh: expect.any(String), en: expect.any(String) });
    }
    // preset 进分组菜单：target 合法、group 存在且携带非空双语 label / description
    for (const entry of entries.filter((e) => e.kind === "preset")) {
      expect(["image", "text"], entry.id).toContain(entry.target);
      expect(entry.group, entry.id).toBeDefined();
      expect(groupIds.has(entry.group!), entry.id).toBe(true);
      expect(entry.label).toMatchObject({ zh: expect.any(String), en: expect.any(String) });
      expect(entry.description).toMatchObject({ zh: expect.any(String), en: expect.any(String) });
      for (const text of [entry.label!, entry.description!]) {
        expect(text.zh).not.toBe("");
        expect(text.en).not.toBe("");
      }
    }
    // 分组按 target 归属：同组条目 target 一致，按 target 过滤后分组不会出现空壳
    for (const group of groups) {
      const members = entries.filter((entry) => entry.group === group.id);
      expect(members.length, group.id).toBeGreaterThan(0);
      expect(new Set(members.map((member) => member.target)).size, group.id).toBe(1);
    }
    // dynamic 不进菜单：无分组与文案，仅服务图片链路
    for (const entry of entries.filter((e) => e.kind !== "preset")) {
      expect(entry.target).toBe("image");
      expect(entry.group).toBeUndefined();
      expect(entry.label).toBeUndefined();
      expect(entry.description).toBeUndefined();
    }
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
