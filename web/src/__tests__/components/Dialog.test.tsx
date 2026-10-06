// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

afterEach(cleanup);

describe("Dialog", () => {
  it("renders the official dialog structure and closes through onOpenChange", () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Account settings</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.className).toContain("relative");
    expect(dialog.className).not.toContain("-translate-x-1/2");
    expect(document.querySelector('[data-slot="dialog-positioner"]')).toHaveClass("fixed", "place-items-center");
    expect(document.querySelector('[data-slot="dialog-positioner"]')).toHaveStyle({ zIndex: "1000" });
    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton.dataset.slot).toBe("dialog-close");
    expect(closeButton.dataset.variant).toBe("ghost");
    expect(closeButton.dataset.size).toBe("icon-sm");
    expect(closeButton.className).toContain("absolute");
    expect(closeButton.className).toContain("top-4");
    expect(closeButton.className).toContain("right-4");
    expect(closeButton.className).toContain("size-8");
    expect(screen.getByRole("heading", { name: "Settings" }).className).toContain("cn-font-heading");
    expect(screen.getByText("Settings")).toBeTruthy();
    expect(screen.getByText("Account settings")).toBeTruthy();
    fireEvent.click(closeButton);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("can omit the overlay for non-modal content", () => {
    render(
      <Dialog open>
        <DialogContent showOverlay={false}>
          <DialogTitle>Canvas</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
  });

  it("focuses the first editable control instead of an action button", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Edit profile</DialogTitle>
          <button type="button">Search</button>
          <input aria-label="Name" />
        </DialogContent>
      </Dialog>,
    );

    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
  });

  it("falls back to the dialog surface when no editable control exists", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Assets</DialogTitle>
          <button type="button">Search</button>
        </DialogContent>
      </Dialog>,
    );

    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });
});
