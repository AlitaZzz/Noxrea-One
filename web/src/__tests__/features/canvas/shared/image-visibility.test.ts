import { describe, expect, it } from "vitest";

import { imagePlacementStyle, layoutMultiImages, placedImageRect } from "@/features/canvas/shared/image-visibility";
import { mediaLoadPriority } from "@/features/canvas/shared/media-visibility";

const viewport = { width: 800, height: 600, transform: [0, 0, 1] as const };

describe("image visibility", () => {
  it("distinguishes visible, prefetch and distant images", () => {
    expect(mediaLoadPriority({ x: 700, y: 100, width: 200, height: 100 }, viewport)).toBe(0);
    expect(mediaLoadPriority({ x: 900, y: 100, width: 100, height: 100 }, viewport)).toBe(1);
    expect(mediaLoadPriority({ x: 1040, y: 100, width: 100, height: 100 }, viewport)).toBeNull();
    expect(mediaLoadPriority({ x: -400, y: 100, width: 160, height: 100 }, viewport)).toBeNull();
  });

  it("keeps prefetch distance fixed in screen pixels at different zoom levels", () => {
    for (const zoom of [0.1, 1, 5]) {
      expect(mediaLoadPriority({ x: 900 / zoom, y: 100 / zoom, width: 100 / zoom, height: 100 / zoom }, { ...viewport, transform: [0, 0, zoom] })).toBe(1);
      expect(mediaLoadPriority({ x: 1041 / zoom, y: 100 / zoom, width: 100 / zoom, height: 100 / zoom }, { ...viewport, transform: [0, 0, zoom] })).toBeNull();
    }
  });

  it("follows viewport translation and rejects unmeasured areas", () => {
    const rect = { x: 5000, y: 100, width: 200, height: 100 };
    expect(mediaLoadPriority(rect, { ...viewport, transform: [-5000, 0, 1] })).toBe(0);
    expect(mediaLoadPriority(rect, { ...viewport, width: 0 })).toBeNull();
    expect(mediaLoadPriority({ ...rect, height: 0 }, viewport)).toBeNull();
  });

  it("keeps the main image at the origin even when it is not the first result", () => {
    expect(layoutMultiImages(["a", "main", "b", "c", "d"], "main")).toEqual([
      { column: 1, row: 0 }, {}, { column: 0, row: -1 }, { column: 1, row: -1 }, { column: 0, row: -2 },
    ]);
  });

  it("loads an expanded result intersecting the viewport while its main node is distant", () => {
    const body = { x: 100, y: 2000, width: 400, height: 500 };
    const placement = { row: -3, column: 0 };
    expect(mediaLoadPriority(body, viewport)).toBeNull();
    expect(placedImageRect(body, placement).y).toBe(476);
    expect(mediaLoadPriority(placedImageRect(body, placement), viewport)).toBe(0);
    expect(imagePlacementStyle(placement).top).toBe("calc(-300% + -24px)");
  });

  it("encloses rotated stack cards and uses the presentation offsets", () => {
    const body = { x: 0, y: 0, width: 600, height: 400 };
    const rect = placedImageRect(body, { stackDepth: 3 });
    expect(rect.x + rect.width / 2).toBeCloseTo(336);
    expect(rect.y + rect.height / 2).toBeCloseTo(212);
    expect(rect.width).toBeGreaterThan(600 * 0.895);
    expect(imagePlacementStyle({ stackDepth: 3 })).toMatchObject({ left: "36px", top: "12px" });
  });
});
