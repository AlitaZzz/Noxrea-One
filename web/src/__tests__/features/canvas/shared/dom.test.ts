// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { isEditableTarget } from "@/features/canvas/shared/dom";

afterEach(() => {
  document.body.replaceChildren();
});

describe("isEditableTarget", () => {
  it("recognizes descendants of a contenteditable editor", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const chip = document.createElement("span");
    editor.append(chip);
    document.body.append(editor);

    expect(isEditableTarget(chip)).toBe(true);
  });

  it("does not treat canvas elements as editable", () => {
    const canvas = document.createElement("div");
    document.body.append(canvas);

    expect(isEditableTarget(canvas)).toBe(false);
  });
});
