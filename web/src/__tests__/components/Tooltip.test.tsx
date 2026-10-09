// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Tooltip", () => {
  it("opens on hover and respects placement", async () => {
    render(<TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button">Action</button></TooltipTrigger><TooltipContent side="bottom" align="end">Helpful text</TooltipContent></Tooltip></TooltipProvider>);
    const trigger = screen.getByRole("button");

    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Helpful text"));
    expect(screen.getByRole("tooltip")).toHaveAttribute("data-side", "bottom");
  });

  it("supports controlled visibility", () => {
    const { rerender } = render(<TooltipProvider><Tooltip open={false}><TooltipTrigger asChild><span>Target</span></TooltipTrigger><TooltipContent>Controlled</TooltipContent></Tooltip></TooltipProvider>);
    expect(screen.queryByRole("tooltip")).toBeNull();

    rerender(<TooltipProvider><Tooltip open><TooltipTrigger asChild><span>Target</span></TooltipTrigger><TooltipContent>Controlled</TooltipContent></Tooltip></TooltipProvider>);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Controlled");
  });

  it.each([true, false])("opens on focus only when focus-visible is %s", async (focusVisible) => {
    const onFocus = vi.fn();
    render(<TooltipProvider><Tooltip><TooltipTrigger asChild onFocus={onFocus}><button type="button">Action</button></TooltipTrigger><TooltipContent>Helpful text</TooltipContent></Tooltip></TooltipProvider>);
    const trigger = screen.getByRole("button");
    const matches = trigger.matches.bind(trigger);
    vi.spyOn(trigger, "matches").mockImplementation((selector) => selector === ":focus-visible" ? focusVisible : matches(selector));

    fireEvent.focus(trigger);

    expect(onFocus).toHaveBeenCalledOnce();
    if (focusVisible) {
      await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Helpful text"));
    } else {
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.pointerMove(trigger, { pointerType: "mouse" });
      await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Helpful text"));
    }
  });
});
