// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Separator } from "@/components/ui/separator";

afterEach(cleanup);

describe("Separator", () => {
  it("allows a fixed vertical separator to be centered by its flex parent", () => {
    render(<Separator orientation="vertical" className="h-5 self-center" />);

    const separator = document.querySelector('[data-slot="separator"]');
    if (!separator) throw new Error("Separator was not rendered");
    expect(separator).toHaveAttribute("data-orientation", "vertical");
    expect(separator).toHaveClass("h-5", "self-center");
    expect(separator.className).not.toContain("self-stretch");
  });
});
