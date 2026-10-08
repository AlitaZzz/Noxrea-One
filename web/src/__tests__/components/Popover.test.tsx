// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { Popover, PopoverAnchor, PopoverAnchorPortal, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

  it("keeps a virtual anchor at the body level while preserving popover context", () => {
    render(
      <Popover open>
        <PopoverAnchorPortal>
          <PopoverAnchor asChild>
            <span data-testid="virtual-anchor" />
          </PopoverAnchor>
        </PopoverAnchorPortal>
        <PopoverContent>Panel</PopoverContent>
      </Popover>,
    );

    expect(document.body.querySelector("[data-testid='virtual-anchor']")).toBeTruthy();
    expect(screen.getByText("Panel")).toBeTruthy();
  });

  it("restores trigger focus when Escape follows a pointer action inside the popover", async () => {
    function PopoverHarness() {
      const [open, setOpen] = useState(false);
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
    fireEvent.click(trigger);
    const action = screen.getByRole("button", { name: "Choose" });

    fireEvent.pointerDown(action);
    fireEvent.keyDown(action, { key: "Escape" });

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps external focus after a pointer outside closes the popover", async () => {
    function PopoverHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button type="button">Open</button>
            </PopoverTrigger>
            <PopoverContent>Panel</PopoverContent>
          </Popover>
          <button type="button">Outside</button>
        </>
      );
    }

    render(<PopoverHarness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    const outside = screen.getByRole("button", { name: "Outside" });

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByText("Panel")).toBeTruthy());

    await act(async () => {
      fireEvent.pointerDown(outside);
      fireEvent.pointerUp(outside);
      outside.focus();
      fireEvent.click(outside);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(screen.queryByText("Panel")).toBeNull();
      expect(document.activeElement).toBe(outside);
    });
  });
});
