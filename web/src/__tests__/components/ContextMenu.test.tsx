// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { LayerContext } from "@/components/ui/modal/layer-context";

afterEach(cleanup);

describe("ContextMenu", () => {
  it("renders through the official structure and selects an item", async () => {
    const onSelect = vi.fn();

    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button type="button">Open menu</button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onSelect}>Action</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Open menu" }), { clientX: 100, clientY: 100 });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Action" })).toBeTruthy());
    expect(screen.getByRole("menuitem", { name: "Action" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Action" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("keeps the body portal and inherits the active layer z-index", async () => {
    const layerRoot = document.createElement("div");
    document.body.appendChild(layerRoot);

    render(
      <LayerContext.Provider value={{ overlayRoot: layerRoot, depth: 1, zIndex: 1000 }}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button type="button">Open menu</button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Action</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </LayerContext.Provider>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Open menu" }), { clientX: 100, clientY: 100 });
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    const menu = screen.getByRole("menu");
    expect(document.body).toContainElement(menu);
    expect(layerRoot).not.toContainElement(menu);
    expect(menu).toHaveStyle({ zIndex: "1001" });
    layerRoot.remove();
  });
});
