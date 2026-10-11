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

  // 模态判定来自 lib/focus-ring.ts 的应用侧追踪，用真实事件驱动而非 mock
  it("opens on focus under keyboard modality", async () => {
    const onFocus = vi.fn();
    render(<TooltipProvider><Tooltip><TooltipTrigger asChild onFocus={onFocus}><button type="button">Action</button></TooltipTrigger><TooltipContent>Helpful text</TooltipContent></Tooltip></TooltipProvider>);
    const trigger = screen.getByRole("button");
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));

    fireEvent.focus(trigger);

    expect(onFocus).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Helpful text"));
  });

  it("suppresses focus-open under pointer modality but keeps hover open", async () => {
    const onFocus = vi.fn();
    render(<TooltipProvider><Tooltip><TooltipTrigger asChild onFocus={onFocus}><button type="button">Action</button></TooltipTrigger><TooltipContent>Helpful text</TooltipContent></Tooltip></TooltipProvider>);
    const trigger = screen.getByRole("button");
    window.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));

    fireEvent.focus(trigger);

    expect(onFocus).toHaveBeenCalledOnce();
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Helpful text"));
  });
});
