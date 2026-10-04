// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

afterEach(cleanup);

describe("ToggleGroup", () => {
  it("uses the shadcn contract and emits a single selected value", () => {
    const onValueChange = vi.fn();
    render(
      <ToggleGroup type="single" variant="outline" defaultValue="perspective" onValueChange={onValueChange} aria-label="View">
        <ToggleGroupItem value="perspective">Perspective</ToggleGroupItem>
        <ToggleGroupItem value="front">Front</ToggleGroupItem>
      </ToggleGroup>,
    );

    const group = screen.getByRole("radiogroup", { name: "View" });
    const perspective = screen.getByRole("radio", { name: "Perspective" });
    const front = screen.getByRole("radio", { name: "Front" });

    expect(group).toHaveAttribute("data-slot", "toggle-group");
    expect(group).toHaveAttribute("data-spacing", "2");
    expect(perspective).toHaveAttribute("data-slot", "toggle-group-item");
    expect(perspective).toHaveAttribute("data-variant", "outline");
    expect(perspective).toHaveClass("border-input");
    expect(perspective).toHaveAttribute("aria-checked", "true");

    fireEvent.click(front);

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("front");
    expect(front).toHaveAttribute("aria-checked", "true");
    expect(perspective).toHaveAttribute("aria-checked", "false");
  });
});
