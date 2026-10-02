// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

afterEach(cleanup);

describe("DropdownMenu", () => {
  it("renders the official controlled structure and selects an item", () => {
    const onOpenChange = vi.fn();
    const onSelect = vi.fn();

    render(
      <DropdownMenu open onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <button type="button">Open menu</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>Action</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(screen.getByRole("menuitem", { name: "Action" })).toBeTruthy();
    expect(screen.getByRole("menu")).toHaveClass("space-y-px");
    fireEvent.click(screen.getByRole("menuitem", { name: "Action" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("does not restore trigger focus after clicking outside on a canvas surface", async () => {
    function MenuHarness() {
      const [open, setOpen] = useState(true);
      return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <button type="button">Canvas action</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Action</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    render(<MenuHarness />);
    const trigger = document.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLButtonElement;
    trigger.focus();

    fireEvent.pointerDown(document.body);

    await waitFor(() => expect(document.activeElement).not.toBe(trigger));
  });

  it("does not restore trigger focus after selecting an item with the pointer", async () => {
    function MenuHarness() {
      const [open, setOpen] = useState(true);
      return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <button type="button">Canvas action</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Action</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    render(<MenuHarness />);
    const trigger = document.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLButtonElement;
    trigger.focus();
    const item = screen.getByRole("menuitem", { name: "Action" });

    fireEvent.pointerDown(item);
    fireEvent.click(item);

    await waitFor(() => expect(document.activeElement).not.toBe(trigger));
  });
});
