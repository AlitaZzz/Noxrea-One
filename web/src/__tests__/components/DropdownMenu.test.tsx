// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LayerContext } from "@/components/ui/modal/layer-context";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

afterEach(cleanup);

describe("DropdownMenu", () => {
  it("allows outside pointer interaction by default", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger asChild><button type="button">Open menu</button></DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuItem>Action</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(document.body).not.toHaveStyle({ pointerEvents: "none" });
  });

  it("allows callers to request a modal menu explicitly", () => {
    render(
      <DropdownMenu open modal>
        <DropdownMenuTrigger asChild><button type="button">Open menu</button></DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuItem>Action</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(document.body).toHaveStyle({ pointerEvents: "none" });
  });

  it("switches between a menu and a sibling popover with one pointer interaction", async () => {
    render(
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button">Models</button></DropdownMenuTrigger>
          <DropdownMenuContent><DropdownMenuItem>Model</DropdownMenuItem></DropdownMenuContent>
        </DropdownMenu>
        <Popover>
          <PopoverTrigger asChild><button type="button">Parameters</button></PopoverTrigger>
          <PopoverContent><input aria-label="Parameter value" /></PopoverContent>
        </Popover>
      </>,
    );
    const models = screen.getByRole("button", { name: "Models" });
    const parameters = screen.getByRole("button", { name: "Parameters" });

    fireEvent.keyDown(models, { key: "ArrowDown" });
    await act(async () => {});
    // jsdom does not enforce pointer-events; assert the real browser prerequisite.
    expect(document.body).not.toHaveStyle({ pointerEvents: "none" });
    fireEvent.pointerDown(parameters, { pointerType: "mouse", button: 0 });
    parameters.focus();
    fireEvent.click(parameters);

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
      expect(screen.getByRole("textbox", { name: "Parameter value" })).toHaveFocus();
    });

    await act(async () => {});
    fireEvent(models, new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    fireEvent.click(models);

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Parameter value" })).toBeNull();
      expect(screen.getByRole("menu")).toHaveFocus();
    });
  });

  it("keeps the focus of an outside input when the menu closes", async () => {
    render(
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button">Open menu</button></DropdownMenuTrigger>
          <DropdownMenuContent><DropdownMenuItem>Action</DropdownMenuItem></DropdownMenuContent>
        </DropdownMenu>
        <input aria-label="Outside input" />
      </>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Open menu" }), { key: "ArrowDown" });
    await act(async () => {});
    const input = screen.getByRole("textbox", { name: "Outside input" });
    fireEvent.pointerDown(input, { pointerType: "mouse", button: 0 });
    input.focus();
    fireEvent.click(input);

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
      expect(input).toHaveFocus();
    });
  });

  it("switches between sibling menus with one pointer interaction", async () => {
    render(
      <>
        {["First", "Second"].map((name) => (
          <DropdownMenu key={name}>
            <DropdownMenuTrigger asChild><button type="button">{name}</button></DropdownMenuTrigger>
            <DropdownMenuContent><DropdownMenuItem>{name} action</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>
        ))}
      </>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "First" }), { key: "ArrowDown" });
    await act(async () => {});
    fireEvent(screen.getByRole("button", { name: "Second" }), new MouseEvent("pointerdown", {
      bubbles: true, cancelable: true, button: 0,
    }));

    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "First" })).toBeNull();
      expect(screen.getByRole("menu", { name: "Second" })).toBeTruthy();
    });
    fireEvent.keyDown(screen.getByRole("menu", { name: "Second" }), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
      expect(screen.getByRole("button", { name: "Second" })).toHaveFocus();
    });
  });

  it("allows interaction inside a modal sheet while preserving its outer isolation", async () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>API settings</SheetTitle>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button type="button">Batch actions</button></DropdownMenuTrigger>
            <DropdownMenuContent><DropdownMenuItem>Select all</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>
          <input aria-label="Search models" />
        </SheetContent>
      </Sheet>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Batch actions" }), { key: "ArrowDown" });
    await act(async () => {});
    const input = screen.getByRole("textbox", { name: "Search models" });
    expect(screen.getByRole("menu")).toHaveStyle({ zIndex: "1001" });
    expect(document.body).toHaveStyle({ pointerEvents: "none" });
    fireEvent.pointerDown(input, { pointerType: "mouse", button: 0 });
    input.focus();
    fireEvent.click(input);

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
      expect(input).toHaveFocus();
      expect(screen.getByRole("dialog", { name: "API settings" })).toBeTruthy();
      expect(document.body).toHaveStyle({ pointerEvents: "none" });
    });
  });

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
    expect(screen.getByRole("menu")).toHaveClass("space-y-px", "min-w-32");
    expect(screen.getByRole("menu")).not.toHaveClass("w-(--radix-dropdown-menu-trigger-width)");
    fireEvent.click(screen.getByRole("menuitem", { name: "Action" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("keeps the official body portal and inherits the active layer z-index", () => {
    const layerRoot = document.createElement("div");
    document.body.appendChild(layerRoot);

    render(
      <LayerContext.Provider value={{ overlayRoot: layerRoot, depth: 1, zIndex: 1000 }}>
        <DropdownMenu open>
          <DropdownMenuTrigger asChild>
            <button type="button">Open menu</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Action</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </LayerContext.Provider>,
    );

    const menu = screen.getByRole("menu");
    expect(document.body).toContainElement(menu);
    expect(layerRoot).not.toContainElement(menu);
    expect(menu).toHaveStyle({ zIndex: "1001" });
    layerRoot.remove();
  });

  it("applies the active layer z-index to submenu content", () => {
    const layerRoot = document.createElement("div");
    document.body.appendChild(layerRoot);

    render(
      <LayerContext.Provider value={{ overlayRoot: layerRoot, depth: 1, zIndex: 1000 }}>
        <DropdownMenu open>
          <DropdownMenuTrigger asChild>
            <button type="button">Open menu</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Sub action</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </LayerContext.Provider>,
    );

    expect(screen.getByRole("menu", { name: "More" })).toHaveStyle({ zIndex: "1001" });
    layerRoot.remove();
  });

  it("does not restore trigger focus after clicking outside on a canvas surface", async () => {
    function MenuHarness() {
      const [open, setOpen] = useState(false);
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
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Action" })).toHaveFocus());
    await act(async () => {});

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).not.toBe(trigger);
    });
  });

  it("restores trigger focus after selecting an item with the pointer", async () => {
    function MenuHarness() {
      const [open, setOpen] = useState(false);
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
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const item = screen.getByRole("menuitem", { name: "Action" });

    fireEvent.pointerDown(item);
    fireEvent.click(item);

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
