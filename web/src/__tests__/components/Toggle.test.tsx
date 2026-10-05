// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

afterEach(cleanup);

describe("Toggle", () => {
  it("uses the shadcn selected-state contract", () => {
    render(<Toggle aria-label="Minimap" defaultPressed>Minimap</Toggle>);

    const toggle = screen.getByRole("button", { name: "Minimap" });
    expect(toggle).toHaveAttribute("data-slot", "toggle");
    expect(toggle).toHaveAttribute("data-state", "on");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveClass("data-[state=on]:bg-accent");
    expect(toggle).toHaveClass("aria-pressed:bg-accent");
  });

  it("emits the next pressed state", () => {
    const onPressedChange = vi.fn();
    render(<Toggle aria-label="Snap" onPressedChange={onPressedChange}>Snap</Toggle>);

    fireEvent.click(screen.getByRole("button", { name: "Snap" }));

    expect(onPressedChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("keeps the selected style when used as a tooltip trigger", () => {
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle aria-label="Minimap" defaultPressed />
          </TooltipTrigger>
          <TooltipContent>Hide minimap</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const toggle = screen.getByRole("button", { name: "Minimap" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveClass("aria-pressed:bg-accent");
  });
});
