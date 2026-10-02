// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";

afterEach(cleanup);

describe("Button", () => {
  it("keeps project variant and size semantics on the native button", () => {
    render(<Button variant="primary" size="sm">Save</Button>);

    const button = screen.getByRole("button", { name: "Save" });

    expect(button.dataset.variant).toBe("primary");
    expect(button.dataset.size).toBe("sm");
  });

  it("replaces content with the loading state and disables interaction", () => {
    render(<Button loading>Save</Button>);
    const button = screen.getByRole("button");

    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector("svg")).toBeTruthy();
  });

  it("keeps icon-only buttons square at the selected size", () => {
    render(<Button iconOnly size="sm" aria-label="More" />);

    const button = screen.getByRole("button", { name: "More" });
    expect(button.className).toContain("size-8");
    expect(button.dataset.size).toBe("sm");
  });
});
