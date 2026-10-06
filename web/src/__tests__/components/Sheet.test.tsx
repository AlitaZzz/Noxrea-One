// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Popover, PopoverContent } from "@/components/ui/popover";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";

afterEach(cleanup);

describe("Sheet", () => {
  it.each(["left", "right"] as const)("pairs the %s exit slide with a fade before unmounting", (side) => {
    render(
      <Sheet open modal={false}>
        <SheetContent side={side} showOverlay={false}>
          <SheetTitle>Canvas panel</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(screen.getByRole("dialog")).toHaveClass(
      "data-closed:animate-out",
      "data-closed:fade-out-0",
      `data-[side=${side}]:data-closed:slide-out-to-${side}-10`,
    );
  });

  it("renders the official sheet structure and reports close events", () => {
    const onOpenChange = vi.fn();
    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>Account settings</SheetDescription>
          <SheetClose>Close drawer</SheetClose>
        </SheetContent>
      </Sheet>,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
    expect(screen.getByText("Account settings")).toBeTruthy();
    const defaultCloseButton = screen.getByRole("button", { name: "Close" });
    expect(defaultCloseButton.className).toContain("size-7");
    expect(defaultCloseButton.className).toContain("top-3");
    expect(defaultCloseButton.className).toContain("right-3");
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("can omit the overlay for canvas side panels", () => {
    render(
      <Sheet open>
        <SheetContent showOverlay={false}>
          <SheetTitle>Canvas</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull();
  });

  it("focuses the sheet surface before its business controls", () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Agent</SheetTitle>
          <button type="button">New conversation</button>
        </SheetContent>
      </Sheet>,
    );

    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("uses the same surface-first policy for non-modal sheets", () => {
    render(
      <Sheet open modal={false}>
        <SheetContent showOverlay={false}>
          <SheetTitle>Agent</SheetTitle>
          <button type="button">New conversation</button>
        </SheetContent>
      </Sheet>,
    );

    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("provides the derived layer to nested popovers", () => {
    render(
      <Sheet open>
        <SheetContent showOverlay={false}>
          <SheetTitle>Settings</SheetTitle>
          <Popover open>
            <PopoverContent>Nested menu</PopoverContent>
          </Popover>
        </SheetContent>
      </Sheet>,
    );

    expect(document.querySelector('[data-slot="sheet-content"]')).toHaveStyle({ zIndex: "1000" });
    expect(screen.getByText("Nested menu").closest("[data-slot='popover-content']")).toHaveStyle({ zIndex: "1001" });
    expect(document.querySelector("[data-layer-overlay-root]")).toHaveAttribute("data-layer-depth", "1");
  });

  it("keeps content styles off the overlay", () => {
    render(
      <Sheet open>
        <SheetContent style={{ width: "480px" }}>
          <SheetTitle>Settings</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(document.querySelector('[data-slot="sheet-content"]')).toHaveStyle({ width: "480px", zIndex: "1000" });
    expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toHaveStyle({ width: "480px" });
  });

  it("uses the width prop as the content size contract", () => {
    render(
      <Sheet open>
        <SheetContent width="480px">
          <SheetTitle>Settings</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    const content = document.querySelector('[data-slot="sheet-content"]');
    expect(content).toHaveStyle({ width: "480px", maxWidth: "480px" });
    expect(content).not.toHaveClass("data-[side=right]:sm:max-w-sm");
  });

  it("can keep a non-modal side panel open while interacting outside", () => {
    const onOpenChange = vi.fn();
    render(
      <Sheet open modal={false} onOpenChange={onOpenChange}>
        <SheetContent
          showOverlay={false}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <SheetTitle>Canvas</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
