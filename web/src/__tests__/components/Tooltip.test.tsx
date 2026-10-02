// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

afterEach(cleanup);

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
});
