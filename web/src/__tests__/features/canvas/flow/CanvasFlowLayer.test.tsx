// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { domNodeRef, createFlowRenderer, destroy } = vi.hoisted(() => ({
  domNodeRef: { current: null as HTMLElement | null },
  destroy: vi.fn(),
  createFlowRenderer: vi.fn(() => ({ destroy })),
}));

vi.mock("@xyflow/react", () => ({
  useStoreApi: () => ({
    getState: () => ({ transform: [0, 0, 1], width: 800, height: 600 }),
  }),
  useStore: (selector: (state: { domNode: HTMLElement | null }) => unknown) =>
    selector({ domNode: domNodeRef.current }),
}));

vi.mock("@/features/canvas/flow/flow-renderer", () => ({ createFlowRenderer }));

import CanvasFlowLayer from "@/features/canvas/flow/CanvasFlowLayer";

function buildDomNode(): { domNode: HTMLElement; viewport: HTMLElement; nodes: HTMLElement } {
  const domNode = document.createElement("div");
  domNode.innerHTML = [
    '<div class="react-flow__viewport">',
    '<div class="react-flow__edges"></div>',
    '<div class="react-flow__nodes"></div>',
    "</div>",
  ].join("");
  return {
    domNode,
    viewport: domNode.querySelector<HTMLElement>(".react-flow__viewport")!,
    nodes: domNode.querySelector<HTMLElement>(".react-flow__nodes")!,
  };
}

beforeEach(() => {
  destroy.mockClear();
  createFlowRenderer.mockClear();
});

afterEach(() => {
  cleanup();
  domNodeRef.current = null;
});

describe("CanvasFlowLayer 生命周期", () => {
  it("把 canvas 图层插到节点层之前，卸载时销毁渲染器并移除图层", () => {
    const { domNode, viewport, nodes } = buildDomNode();
    domNodeRef.current = domNode;

    const { unmount } = render(<CanvasFlowLayer />);

    const layer = viewport.querySelector<HTMLElement>(".canvas-flow-layer");
    expect(layer).toBeTruthy();
    expect(layer!.nextElementSibling).toBe(nodes);
    expect(layer!.querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true");
    expect(createFlowRenderer).toHaveBeenCalledTimes(1);

    unmount();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(viewport.querySelector(".canvas-flow-layer")).toBeNull();
  });

  it("视口或节点层缺失时不创建图层", () => {
    const domNode = document.createElement("div");
    domNodeRef.current = domNode;

    const { unmount } = render(<CanvasFlowLayer />);

    expect(createFlowRenderer).not.toHaveBeenCalled();
    expect(domNode.querySelector(".canvas-flow-layer")).toBeNull();

    unmount();
    expect(destroy).not.toHaveBeenCalled();
  });
});
