import { describe, expect, it } from "vitest";

import en from "@/lib/i18n/en-US.json";
import zh from "@/lib/i18n/zh-CN.json";

describe("canvas save status i18n", () => {
  it("keeps the same non-empty canvas.save keys in both locales", () => {
    const zhSave = zh.canvas.save as Record<string, string>;
    const enSave = en.canvas.save as Record<string, string>;

    expect(Object.keys(zhSave).sort()).toEqual(Object.keys(enSave).sort());
    for (const key of Object.keys(zhSave)) {
      expect(zhSave[key]).toBeTruthy();
      expect(enSave[key]).toBeTruthy();
    }
  });

  it("removes the old top-level offline block without touching upload offline", () => {
    expect("offline" in zh).toBe(false);
    expect("offline" in en).toBe(false);
    expect(zh.error.upload.offline).toBeTruthy();
    expect(en.error.upload.offline).toBeTruthy();
    expect(zh.common.saved).toBeTruthy();
    expect(en.common.saved).toBeTruthy();
  });
});
