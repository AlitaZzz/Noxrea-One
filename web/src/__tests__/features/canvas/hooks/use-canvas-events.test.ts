// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useCanvasEvents } from "@/features/canvas/hooks/use-canvas-events";
import { useContextMenuStore } from "@/features/canvas/stores/context-menu-store";

afterEach(() => {
  cleanup();
  act(() => useContextMenuStore.getState().hide());
});

describe("useCanvasEvents", () => {
  it("opens the create menu for a blank canvas double click", () => {
    const container = document.createElement("div");
    const pane = document.createElement("div");
    pane.className = "react-flow__pane";
    container.appendChild(pane);
    document.body.appendChild(container);

    renderHook(() => useCanvasEvents({ current: container }));

    act(() => {
      pane.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 120, clientY: 240 }));
    });

    expect(useContextMenuStore.getState()).toMatchObject({ visible: true, kind: "create", x: 120, y: 240 });
  });

  it("keeps node double clicks and editable context menus outside the canvas menu flow", () => {
    const container = document.createElement("div");
    const pane = document.createElement("div");
    pane.className = "react-flow__pane";
    const node = document.createElement("div");
    node.className = "react-flow__node";
    pane.appendChild(node);
    const input = document.createElement("input");
    container.append(pane, input);
    document.body.appendChild(container);

    renderHook(() => useCanvasEvents({ current: container }));

    act(() => {
      node.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 20, clientY: 30 }));
    });
    expect(useContextMenuStore.getState().visible).toBe(false);

    const paneContextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    pane.dispatchEvent(paneContextMenu);
    expect(paneContextMenu.defaultPrevented).toBe(true);

    const inputContextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    input.dispatchEvent(inputContextMenu);
    expect(inputContextMenu.defaultPrevented).toBe(false);
  });
});
