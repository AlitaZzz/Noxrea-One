// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { getLayerPopupContainer } from "@/components/ui/modal/layer-context";

afterEach(() => { document.body.replaceChildren(); });

describe("layer popup container", () => {
  it("finds the overlay sibling of the trigger content", () => {
    document.body.innerHTML = '<div data-layer-scope><div><button>Trigger</button></div><div data-layer-overlay-root></div></div>';
    expect(getLayerPopupContainer(document.querySelector("button")!)).toBe(document.querySelector("[data-layer-overlay-root]"));
  });

  it("uses the nearest scope for nested modals rather than the parent overlay", () => {
    document.body.innerHTML = '<div data-layer-scope><div data-layer-overlay-root id="parent"><div data-layer-scope><button>Trigger</button><div data-layer-overlay-root id="child"></div></div></div></div>';
    expect(getLayerPopupContainer(document.querySelector("button")!)).toBe(document.getElementById("child"));
  });

  it("falls back to the body for triggers outside any modal and calls without a trigger", () => {
    const button = document.createElement("button");
    document.body.append(button);
    expect(getLayerPopupContainer(button)).toBe(document.body);
    expect(getLayerPopupContainer()).toBe(document.body);
  });
});
