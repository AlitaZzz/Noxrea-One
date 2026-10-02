// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

afterEach(cleanup);

describe("Popover", () => {
  it("uses the shadcn trigger and content contract", () => {
    render(
      <Popover>
        <PopoverTrigger asChild>
          <button type="button">Open</button>
        </PopoverTrigger>
        <PopoverContent side="bottom" align="end">Panel</PopoverContent>
      </Popover>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(screen.getByText("Panel")).toBeTruthy();
    expect(screen.getByText("Panel").closest("[data-slot='popover-content']")).toHaveAttribute("data-side", "bottom");
  });

  it("composes a tooltip trigger with the popover trigger on one control", () => {
    render(
      <TooltipProvider>
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button type="button">Open</button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>Help</TooltipContent>
          </Tooltip>
          <PopoverContent>Panel</PopoverContent>
        </Popover>
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByText("Panel")).toBeTruthy();
  });

  it("does not restore trigger focus after a pointer action closes the popover", async () => {
    function PopoverHarness() {
      const [open, setOpen] = useState(true);
      return (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button">Open</button>
          </PopoverTrigger>
          <PopoverContent>
            <button type="button" onClick={() => setOpen(false)}>Choose</button>
          </PopoverContent>
        </Popover>
      );
    }

    render(<PopoverHarness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    trigger.focus();
    const action = screen.getByRole("button", { name: "Choose" });

    fireEvent.pointerDown(action);
    fireEvent.click(action);

    await waitFor(() => expect(document.activeElement).not.toBe(trigger));
  });
});
